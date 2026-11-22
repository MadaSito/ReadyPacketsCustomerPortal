import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const validator = resolve(import.meta.dirname, "../../deploy/check-migration-bundle.mjs");
const assertion = resolve(import.meta.dirname, "assert-release-migrations.sh");
const tags = ["0000_baseline", "0001_contract", "0002_contract", "0003_contract", "0004_contract", "0005_increment_05"];
const sql = "SELECT 1;\n";
const digest = createHash("sha256").update(sql).digest("hex");
let fixture: string;
function journal(list = tags) {
  writeFileSync(join(fixture, "meta", "_journal.json"),
    JSON.stringify({ entries: list.map((tag, idx) => ({ tag, idx })) }));
}
function validate() {
  return spawnSync(process.execPath, [validator, fixture], { encoding: "utf8" });
}
function assertJournal(count: string) {
  return spawnSync("bash", ["-ec", `
    source "$1"
    fail() { printf '%s\\n' "$1" >&2; exit 1; }
    expect() { [[ $2 == "$3" ]] || fail "$1: expected $3, got $2"; }
    query() {
      [[ $1 == "SELECT COUNT(*) FROM readypackets.__drizzle_migrations WHERE hash='$digest'" ]] || return 2
      printf '%s\\n' "$mock_rows"
    }
    digest=$2 mock_rows=$3
    assert_release_migrations "$4" query 0005_increment_05
  `, "release-migrations-test", assertion, digest, count, fixture], { encoding: "utf8" });
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "rp-migration-bundle-"));
  mkdirSync(join(fixture, "meta"));
  journal();
  for (const tag of tags) writeFileSync(join(fixture, `${tag}.sql`), sql);
});
afterEach(() => rmSync(fixture, { force: true, recursive: true }));

describe("native and Docker release migration bundle", () => {
  it("accepts the complete release bundle", () => expect(validate().status).toBe(0));
  it("rejects SQL with a missing 0005 journal entry", () => {
    journal(tags.slice(0, -1));
    expect(validate().status).toBe(1);
  });
  it("rejects a journal entry whose SQL is missing", () => {
    rmSync(join(fixture, "0005_increment_05.sql"));
    expect(validate().status).toBe(1);
  });
  it("rejects a file not covered by the journal", () => {
    writeFileSync(join(fixture, "0005_other.sql"), sql);
    expect(validate().status).toBe(1);
  });
  it("rejects a replaced migration SQL symlink", () => {
    const newest = join(fixture, "0005_increment_05.sql");
    rmSync(newest);
    symlinkSync("0004_contract.sql", newest);
    expect(validate().status).toBe(1);
  });
  it("rejects a replaced migration journal symlink", () => {
    const manifest = join(fixture, "meta", "_journal.json");
    renameSync(manifest, join(fixture, "meta", "real-journal.json"));
    symlinkSync("real-journal.json", manifest);
    expect(validate().status).toBe(1);
  });
});

describe("deployment CI database journal assertion", () => {
  it("queries the SQL digest and accepts exactly one journal row", () => expect(assertJournal("1").status).toBe(0));
  it.each(["0", "2"])("rejects a journal count of %s", (count) => {
    expect(assertJournal(count)).toMatchObject({
      status: 1, stderr: expect.stringContaining(`0005_increment_05 journal entries: expected 1, got ${count}`),
    });
  });
});
