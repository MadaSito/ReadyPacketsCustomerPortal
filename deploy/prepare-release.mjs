// Invoked as root from the trusted deploy checkout. Never execute artifact code.
import fs from "node:fs";
import path from "node:path";
import { checkMigrationBundle } from "./check-migration-bundle.mjs";

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY, O_CREAT, O_EXCL, O_WRONLY } = fs.constants;
const read = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
const trees = ["dist", "migrations", "node_modules", "data/catalog"];
const required = [
  "package.json", "dist/server/main.js", "dist/public/index.html", "migrations/meta/_journal.json",
  "dist/ops/migrate.js", "dist/ops/create-admin.js", "dist/ops/recover-admin.js", "dist/ops/catalog-import.js",
  "dist/ops/run-backup.js", "dist/ops/verify-backup.js",
  "dist/ops/restore-isolated.js", "dist/ops/generate-keys.js", "dist/ops/keys-doctor.js",
  "data/catalog/readypackets-offerings-v3.0.json", "data/catalog/offerings.schema.json",
];
const fdPath = (fd, name) => `/proc/self/fd/${fd}/${name}`;

function check(stat, uid, promoted) {
  if (stat.uid !== uid || (stat.mode & 0o022) !== 0 || (promoted && stat.gid !== 0)) {
    throw new Error("unexpected artifact ownership or permissions");
  }
  if (!stat.isDirectory() && !stat.isFile()) throw new Error("unexpected artifact file type");
}

function visit(source, uid, dest, promoted = false) {
  // Anchor each lookup to the already-open parent and refuse symlinks at the leaf.
  // Nonblocking open keeps special files from hanging root before fstat rejects them.
  const fd = fs.openSync(source, read);
  try {
    const stat = fs.fstatSync(fd);
    check(stat, uid, promoted);
    if (stat.isDirectory()) {
      if (dest) fs.mkdirSync(dest, { mode: 0o755 });
      for (const name of fs.readdirSync(`/proc/self/fd/${fd}`)) {
        // Package-manager command shims are not needed at runtime.
        if (!promoted && dest && name === ".bin" && dest.includes("/node_modules")) continue;
        if (dest?.endsWith("/dist/ops") && /^seed-demo\.js(?:\.map)?$/.test(name)) continue;
        if (!promoted && dest?.endsWith("/data") && name !== "catalog") continue;
        visit(fdPath(fd, name), uid, dest ? path.join(dest, name) : undefined, promoted);
      }
    } else if (dest) {
      const mode = (stat.mode & 0o111) === 0 ? 0o644 : 0o755;
      const out = fs.openSync(dest, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
      try {
        const buffer = Buffer.allocUnsafe(128 * 1024);
        for (;;) {
          const size = fs.readSync(fd, buffer);
          if (!size) break;
          for (let n = 0; n < size;) n += fs.writeSync(out, buffer, n, size - n);
        }
        fs.fchmodSync(out, mode);
      } finally {
        fs.closeSync(out);
      }
    }
    if (dest && stat.isDirectory()) fs.chmodSync(dest, 0o755);
  } finally {
    fs.closeSync(fd);
  }
}

function validateRelease(dir, commit) {
  visit(dir, 0, undefined, true);
  for (const item of required) {
    if (!fs.lstatSync(path.join(dir, item)).isFile()) throw new Error("missing regular release artifact");
  }
  for (const tree of trees) {
    if (!fs.lstatSync(path.join(dir, tree)).isDirectory()) throw new Error("missing release directory");
  }
  if (fs.existsSync(path.join(dir, "dist/ops/seed-demo.js"))) throw new Error("demo operation in production");
  checkMigrationBundle(path.join(dir, "migrations"));
  if (fs.readFileSync(path.join(dir, "release.env"), "utf8") !== `RP_RELEASE_REF=${commit}\n`) {
    throw new Error("release metadata does not match reviewed commit");
  }
}

function importEntries(source, destination, uid, entries) {
  const fd = fs.openSync(source, read | O_DIRECTORY);
  try {
    check(fs.fstatSync(fd), uid, uid === 0);
    for (const entry of entries) visit(fdPath(fd, entry), uid, path.join(destination, entry));
  } finally {
    fs.closeSync(fd);
  }
}

try {
  const [mode, commit, first, second, buildUid, reviewed] = process.argv.slice(2);
  if (process.geteuid() !== 0 || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("invalid release context");
  if (mode === "check") {
    validateRelease(first, commit);
  } else if (mode === "import" && /^[1-9][0-9]*$/.test(buildUid)) {
    const target = fs.lstatSync(second);
    if (!target.isDirectory() || target.uid !== 0 || target.gid !== 0 ||
        (target.mode & 0o777) !== 0o700 || fs.readdirSync(second).length) {
      throw new Error("expected a fresh root-only publication directory");
    }
    importEntries(first, second, Number(buildUid), ["dist", "node_modules", "data"]);
    importEntries(reviewed, second, 0, ["migrations", "package.json"]);
    fs.writeFileSync(path.join(second, "release.env"), `RP_RELEASE_REF=${commit}\n`, { flag: "wx", mode: 0o644 });
    validateRelease(second, commit);
  } else {
    throw new Error("invalid artifact preparation arguments");
  }
} catch {
  console.error("ReadyPackets: release artifacts are missing, unsafe, or do not match the reviewed commit.");
  process.exitCode = 1;
}
