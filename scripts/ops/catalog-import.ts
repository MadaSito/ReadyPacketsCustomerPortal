/**
 * Imports the offerings data file (default data/catalog/readypackets-offerings-v3.0.json) into the catalog.
 *
 *   pnpm ops:catalog-import                     # apply
 *   pnpm ops:catalog-import --dry-run           # validate + run the whole import in a rolled-back transaction
 *   pnpm ops:catalog-import --file <path.json>  # a different offerings document (same schema)
 *
 * The file is validated against the offerings schema (scripts/ops/catalog/offerings.ts) BEFORE anything
 * touches the database; an invalid file is refused. The import is one call to
 * orders.catalog.upsertFromOfferings as the in-process system actor `ops.catalog_import` (one transaction,
 * every change audited with source "offerings_import"). It is idempotent: groups and products match on
 * groupKey/productKey, a new product version is written only when its content differs, the bundle rule
 * (`orders.bundle_rule`) is written from Packet 7, and nothing is ever deleted or deactivated.
 * Packet 8 (reserved) is never sent to the catalog.
 *
 * Exit codes: 0 imported / dry run ok · 1 failed · 64 usage · 65 invalid offerings file ·
 *             66 file not readable · 78 configuration.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AppConfig } from "../../server/config/env.js";
import { DomainError } from "../../server/core/errors.js";
import type { OfferingsImportInput, OfferingsImportResult } from "../../server/modules/orders/catalog.js";
import { toImportInput } from "./catalog/importInput.js";
import { DEFAULT_OFFERINGS_FILE, OfferingsFileError, loadOfferings, type Offerings } from "./catalog/offerings.js";

export const CATALOG_IMPORT_ACTOR = { system: "ops.catalog_import" } as const;
const MAX_FILE_BYTES = 1024 * 1024;

export { toImportInput };

export interface CatalogImportArgs {
  file: string;
  dryRun: boolean;
}

export type ParsedArgs = { ok: true; args: CatalogImportArgs } | { ok: false; help: boolean };

export function parseArgs(argv: readonly string[], cwd = process.cwd()): ParsedArgs {
  let file = DEFAULT_OFFERINGS_FILE;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") return { ok: false, help: true };
    else if (arg === "--file") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) return { ok: false, help: false };
      file = path.resolve(cwd, value);
    } else return { ok: false, help: false };
  }
  return { ok: true, args: { file, dryRun } };
}

export const USAGE = "Usage: pnpm ops:catalog-import [--dry-run] [--file <offerings.json>]";

export type ImportOfferings = (input: OfferingsImportInput, opts: { dryRun: boolean }) => Promise<OfferingsImportResult>;

export type CatalogImportOutcome =
  | { status: "imported" | "dry_run"; result: OfferingsImportResult; packets: number; products: number }
  | { status: "invalid_file"; issues: string[]; message: string }
  | { status: "unreadable_file" };

/** Validates the file first; only a valid document reaches `importOfferings`. */
export async function runCatalogImport(importOfferings: ImportOfferings, args: CatalogImportArgs): Promise<CatalogImportOutcome> {
  try {
    const info = await stat(args.file);
    if (!info.isFile()) return { status: "unreadable_file" };
    if (info.size > MAX_FILE_BYTES) return { status: "invalid_file", issues: [], message: "offerings file too large" };
  } catch {
    return { status: "unreadable_file" };
  }
  let doc: Offerings;
  try {
    doc = await loadOfferings(args.file);
  } catch (error) {
    if (error instanceof OfferingsFileError) return { status: "invalid_file", issues: error.issues, message: error.message };
    return { status: "unreadable_file" };
  }
  const input = toImportInput(doc);
  const result = await importOfferings(input, { dryRun: args.dryRun });
  return {
    status: args.dryRun ? "dry_run" : "imported",
    result,
    packets: input.packets.length,
    products: input.packets.reduce((n, p) => n + p.tiers.length, 0),
  };
}

export function renderOutcome(outcome: CatalogImportOutcome, file: string): string[] {
  if (outcome.status === "unreadable_file") return [`Not imported: the offerings file could not be read (${path.basename(file)}).`];
  if (outcome.status === "invalid_file") {
    return [`Not imported: ${outcome.message} (${path.basename(file)}).`, ...outcome.issues.slice(0, 50).map((i) => `  ! ${i}`)];
  }
  const r = outcome.result;
  return [
    outcome.status === "dry_run"
      ? `Dry run (rolled back, nothing changed): ${outcome.packets} packets, ${outcome.products} products checked.`
      : `Catalog imported: ${outcome.packets} packets, ${outcome.products} products.`,
    `  groups:   ${r.groups.created} created, ${r.groups.updated} updated, ${r.groups.unchanged} unchanged`,
    `  products: ${r.products.created} created, ${r.products.versioned} new versions, ${r.products.unchanged} unchanged`,
    `  bundle rule: ${r.bundleRule}`,
  ];
}

const out = (line: string) => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    (parsed.help ? out : err)(USAGE);
    return parsed.help ? 0 : 64;
  }
  const { ConfigError, loadConfig } = await import("../../server/config/env.js");
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    err(error instanceof ConfigError ? error.message : "Configuration could not be loaded.");
    return 78;
  }
  const { createContainer } = await import("../../server/container.js");
  const container = createContainer(config);
  try {
    await container.services.platform.assertSchemaContract();
    const outcome = await runCatalogImport(
      (input, opts) => container.services.orders.catalog.upsertFromOfferings(CATALOG_IMPORT_ACTOR, input, opts),
      parsed.args,
    );
    const lines = renderOutcome(outcome, parsed.args.file);
    if (outcome.status === "imported" || outcome.status === "dry_run") {
      lines.forEach(out);
      return 0;
    }
    lines.forEach(err);
    return outcome.status === "invalid_file" ? 65 : 66;
  } catch (error) {
    if (error instanceof DomainError) {
      err(`Not imported: ${error.safeMessage} (${error.reasonCode}).`);
      return 1;
    }
    err("The catalog could not be imported (unexpected error; see the service log for the correlated record).");
    return 1;
  } finally {
    await container.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    () => {
      err("The catalog could not be imported.");
      process.exit(1);
    },
  );
}
