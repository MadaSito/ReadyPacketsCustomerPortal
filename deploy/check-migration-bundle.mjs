import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const requiredTag = "0006_increment_06";

// A release must include both the journal entry and SQL; a file omitted from
// the journal would otherwise be silently skipped by Drizzle.
export function checkMigrationBundle(dir) {
  const journal = join(dir, "meta", "_journal.json");
  // Check and read through one descriptor (no symlink is followed), so the file that was checked is the
  // file that is read.
  const fd = openSync(journal, constants.O_RDONLY | constants.O_NOFOLLOW);
  let text;
  try {
    if (!fstatSync(fd).isFile()) throw new Error("invalid migration journal file");
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  const { entries } = JSON.parse(text);
  if (!Array.isArray(entries)) throw new Error("invalid migration journal");
  const seen = new Set();
  for (const [idx, entry] of entries.entries()) {
    const { tag } = entry;
    if (entry.idx !== idx || typeof tag !== "string" || !/^\d{4}_[a-z0-9_]+$/u.test(tag) ||
        !tag.startsWith(`${String(idx).padStart(4, "0")}_`) || seen.has(tag)) {
      throw new Error("invalid migration journal entry");
    }
    const stat = lstatSync(join(dir, `${tag}.sql`));
    if (!stat.isFile() || stat.size === 0) throw new Error("invalid migration SQL file");
    seen.add(tag);
  }
  if (!seen.has(requiredTag)) throw new Error("required migration absent");
  if (readdirSync(dir).some((name) => name.endsWith(".sql") && !seen.has(name.slice(0, -4)))) {
    throw new Error("migration SQL missing from journal");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    checkMigrationBundle(process.argv[2]);
  } catch {
    console.error("ReadyPackets: the packaged migration journal or SQL is incomplete or invalid.");
    process.exitCode = 1;
  }
}
