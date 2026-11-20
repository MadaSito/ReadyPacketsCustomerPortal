#!/usr/bin/env node
/**
 * Independent ReadyPackets portable package tool. No database, no server code, no network.
 *
 *   tsx portable/cli/verify.ts verify  <package> (--passphrase-file <f> | --passphrase-env <VAR>) [--json]
 *   tsx portable/cli/verify.ts extract <package> <new-empty-dir> (--passphrase-file <f> | --passphrase-env <VAR>)
 *   tsx portable/cli/verify.ts plan    <package> (--passphrase-file <f> | --passphrase-env <VAR>)
 *
 * The passphrase is never accepted as a command-line value (it would leak through process listings).
 *
 * Exit codes: 0 verified · 1 verification failed · 2 usage error · 3 passphrase rejected / header tampered ·
 *             4 unsupported format, contract, KDF parameters or required module/extension ·
 *             5 local I/O error (file missing/unreadable/unwritable). Archive-structure and integrity failures
 *             (bad entry names, ratio/size limits, digests) are verification failures and return 1.
 */
import { constants } from "node:fs";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createWriteStream } from "node:fs";
import { openPackage } from "../src/reader.js";
import { canonicalJson } from "../src/json.js";
import { isPortableError, type PortableErrorCode } from "../src/errors.js";
import type { VerificationReport } from "../src/types.js";
import { buildPlan } from "../reference-importer/plan.js";

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, PASSPHRASE: 3, UNSUPPORTED: 4, IO: 5 } as const;

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
}

const USAGE = `usage:
  verify  <package> (--passphrase-file <file> | --passphrase-env <VAR>) [--json]
  extract <package> <new-empty-dir> (--passphrase-file <file> | --passphrase-env <VAR>)
  plan    <package> (--passphrase-file <file> | --passphrase-env <VAR>)`;

function exitFor(code: PortableErrorCode): number {
  if (code === "PASSPHRASE_REJECTED") return EXIT.PASSPHRASE;
  if (code === "UNSUPPORTED_ENVELOPE" || code === "UNSUPPORTED_CONTRACT" || code === "KDF_PARAMS_REJECTED") return EXIT.UNSUPPORTED;
  if (code === "INPUT_INVALID") return EXIT.USAGE;
  if (code === "IO_ERROR") return EXIT.IO;
  return EXIT.FAILED;
}

/** A failed report that is failed only because of unsupported required features maps to 4, else 1. */
function reportExit(r: VerificationReport): number {
  return r.issues.length > 0 && r.issueCount === r.issues.length && r.issues.every((i) => i.code === "UNSUPPORTED_EXTENSION" || i.code === "UNSUPPORTED_CONTRACT") ? EXIT.UNSUPPORTED : EXIT.FAILED;
}

function formatReport(r: VerificationReport): string {
  const lines = [
    `result:            ${r.ok ? "VERIFIED" : "FAILED"}`,
    `format:            ${r.sourceFormat} (contract ${r.contractVersion})`,
    `package id:        ${r.packageId}`,
    `manifest sha256:   ${r.manifestSha256}`,
    `ciphertext sha256: ${r.ciphertextSha256}`,
    `objects:           ${r.objects.count} (${r.objects.bytes} bytes)`,
    "records:",
    ...Object.entries(r.counts).map(([t, n]) => `  ${t.padEnd(22)} ${n}`),
    `held-unknown fields: ${r.heldUnknown}`,
  ];
  if (r.heldExtensions.length) lines.push("held extensions (inert, not interpreted):", ...r.heldExtensions.map((x) => `  ${x.name} ${x.version} (${x.count} lines)`));
  if (r.issueCount) lines.push(`issues (${r.issueCount}${r.issueCount > r.issues.length ? `, first ${r.issues.length} shown` : ""}):`, ...r.issues.map((i) => `  ${i.code}: ${i.message}${i.recordType ? ` [${i.recordType}${i.line ? ` line ${i.line}` : ""}]` : ""}${i.path ? ` (${i.path})` : ""}`));
  if (r.warnings.length) lines.push("warnings:", ...r.warnings.map((w) => `  ${w.code}: ${w.message}`));
  if (r.losses.length) lines.push("losses / not carried:", ...r.losses.map((l) => `  ${l.code}${l.count && l.count > 1 ? ` (x${l.count})` : ""}: ${l.message}`));
  lines.push("note: integrity proves the bytes match what the passphrase holder sealed; it does not prove the source organization's identity.");
  return lines.join("\n") + "\n";
}

async function readPassphrase(args: Map<string, string>, io: CliIo): Promise<string | null> {
  const file = args.get("--passphrase-file");
  const envName = args.get("--passphrase-env");
  if ((file ? 1 : 0) + (envName ? 1 : 0) !== 1) return null;
  if (file) {
    const v = (await readFile(path.resolve(io.cwd, file), "utf8")).replace(/\r?\n$/, "");
    return v;
  }
  if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(envName!)) return null;
  return io.env[envName!] ?? null;
}

async function writeNew(file: string, data: string | Buffer): Promise<void> {
  const fh = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string>();
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--json") json = true;
    else if (a === "--passphrase-file" || a === "--passphrase-env") {
      const v = rest[++i];
      if (!v || flags.has(a)) {
        io.err(USAGE + "\n");
        return EXIT.USAGE;
      }
      flags.set(a, v);
    } else if (a.startsWith("--")) {
      io.err(`unknown option\n${USAGE}\n`);
      return EXIT.USAGE;
    } else positional.push(a);
  }
  const want = command === "extract" ? 2 : 1;
  if (!command || !["verify", "extract", "plan"].includes(command) || positional.length !== want) {
    io.err(USAGE + "\n");
    return EXIT.USAGE;
  }
  let passphrase: string | null;
  try {
    passphrase = await readPassphrase(flags, io);
  } catch {
    io.err("error: the passphrase file could not be read\n");
    return EXIT.IO;
  }
  if (!passphrase) {
    io.err(`a passphrase source is required (exactly one of --passphrase-file / --passphrase-env)\n${USAGE}\n`);
    return EXIT.USAGE;
  }
  const input = path.resolve(io.cwd, positional[0]!);
  let pkg;
  try {
    pkg = await openPackage({ input, passphrase });
  } catch (e) {
    if (isPortableError(e)) {
      io.err(`error: ${e.code}: ${e.message}\n`);
      return exitFor(e.code);
    }
    io.err("error: the package could not be read\n");
    return EXIT.IO;
  }
  try {
    const report = await pkg.verify();
    if (command === "verify") {
      io.out(json ? JSON.stringify(report, null, 2) + "\n" : formatReport(report));
      return report.ok ? EXIT.OK : reportExit(report);
    }
    if (!report.ok) {
      io.err(formatReport(report));
      io.err("error: refusing to continue with an unverified package\n");
      return reportExit(report);
    }
    if (command === "plan") {
      const plan = await buildPlan(pkg, report);
      io.out(JSON.stringify(plan, null, 2) + "\n");
      return EXIT.OK;
    }
    // extract: target must not exist yet (no merging into existing trees, no following links).
    const dest = path.resolve(io.cwd, positional[1]!);
    const exists = await stat(dest).then(
      () => true,
      () => false,
    );
    if (exists) {
      io.err("error: the extraction directory must not already exist\n");
      return EXIT.USAGE;
    }
    await mkdir(dest, { mode: 0o700 });
    await mkdir(path.join(dest, "records"), { mode: 0o700 });
    await mkdir(path.join(dest, "objects"), { mode: 0o700 });
    const verbatim = pkg.sourceFormat === "v3" && pkg.verbatimEntries && pkg.openVerbatimEntry;
    if (verbatim) {
      // v3: every archive entry exactly as sealed and verified (manifest, records, extensions, objects);
      // the manifest digests in the output therefore describe the output byte-for-byte.
      for (const name of pkg.verbatimEntries!()) {
        if (name.startsWith("extensions/")) await mkdir(path.join(dest, "extensions"), { mode: 0o700 }).catch(() => undefined);
        const target = path.join(dest, ...name.split("/"));
        await pipeline(await pkg.openVerbatimEntry!(name), createWriteStream(target, { flags: "wx", mode: 0o600 }));
      }
    } else {
      // Legacy: there is no v3 archive; records are RECONSTRUCTED (upgraded in memory). This is declared
      // in extraction-info.json and the manifest is written under a name that cannot be mistaken for one.
      await writeNew(path.join(dest, "upgraded-manifest.json"), canonicalJson(pkg.manifest) + "\n");
      for (const entry of pkg.manifest.records) {
        const lines: string[] = [];
        const fh = await open(path.join(dest, "records", `${entry.type}.jsonl`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          for await (const rec of pkg.records(entry.type)) {
            lines.push(canonicalJson(rec) + "\n");
            if (lines.length >= 1000) await fh.write(lines.splice(0).join(""));
          }
          if (lines.length) await fh.write(lines.join(""));
        } finally {
          await fh.close();
        }
      }
      for (const o of pkg.listObjects()) {
        // Name is a validated 64-hex digest — never a source-provided path.
        await pipeline(await pkg.openObject(o.sha256), createWriteStream(path.join(dest, "objects", o.sha256), { flags: "wx", mode: 0o600 }));
      }
    }
    await writeNew(
      path.join(dest, "extraction-info.json"),
      JSON.stringify(
        {
          mode: verbatim ? "verbatim" : "reconstructed-from-legacy",
          sourceFormat: pkg.sourceFormat,
          ciphertextSha256: report.ciphertextSha256,
          sourceManifestSha256: report.manifestSha256,
          note: verbatim
            ? "Files are the exact verified archive entries; manifest.json digests apply to them."
            : "Records were upgraded from a legacy package in memory; upgraded-manifest.json digests do not describe these files. See verification-report.json losses.",
        },
        null,
        2,
      ) + "\n",
    );
    await writeNew(path.join(dest, "verification-report.json"), JSON.stringify(report, null, 2) + "\n");
    io.out(`extracted ${pkg.manifest.records.reduce((a, r) => a + r.count, 0)} records and ${pkg.listObjects().length} objects\n`);
    return EXIT.OK;
  } catch (e) {
    io.err(`error: ${isPortableError(e) ? `${e.code}: ${e.message}` : "the operation failed"}\n`);
    return isPortableError(e) ? exitFor(e.code) : EXIT.IO;
  } finally {
    await pkg.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runCli(process.argv.slice(2), {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    env: process.env,
    cwd: process.cwd(),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = EXIT.IO;
    },
  );
}
