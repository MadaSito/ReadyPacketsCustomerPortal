/**
 * Schema contract: the release's Drizzle migration journal must match the database's applied migrations
 * exactly (same count, same order, same content hashes). Owner: platform engineer.
 *
 * Drizzle's mysql2 migrator records each applied migration in `__drizzle_migrations` as
 * (hash = sha256(file contents), created_at = journal `when`). We recompute the same identities from the
 * release files, so an edited migration file, a database migrated by a newer release, a database that is
 * behind, or a foreign history are all refused. Reports carry counts and tags only.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DomainError } from "../../core/errors.js";
import type { Db } from "../../core/types.js";
import type { SchemaStatus } from "./index.js";

export const MIGRATIONS_TABLE = "__drizzle_migrations";

const journalSchema = z.object({
  version: z.string().max(16).optional(),
  dialect: z.literal("mysql"),
  entries: z
    .array(
      z.object({
        idx: z.number().int().min(0),
        when: z.number().int().positive(),
        tag: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
        breakpoints: z.boolean().optional(),
        version: z.string().max(16).optional(),
      }),
    )
    .max(10_000),
});

export interface ReleaseMigration {
  tag: string;
  when: number;
  hash: string;
}

export async function readReleaseMigrations(migrationsDir: string): Promise<ReleaseMigration[]> {
  const journal = journalSchema.parse(JSON.parse(await readFile(join(migrationsDir, "meta", "_journal.json"), "utf8")));
  const out: ReleaseMigration[] = [];
  let previousWhen = 0;
  for (const entry of journal.entries) {
    if (entry.when <= previousWhen) throw new Error("journal entries out of order");
    previousWhen = entry.when;
    const contents = await readFile(join(migrationsDir, `${entry.tag}.sql`));
    out.push({ tag: entry.tag, when: entry.when, hash: createHash("sha256").update(contents.toString()).digest("hex") });
  }
  return out;
}

interface AppliedRow {
  hash: string;
  created_at: number | string | null;
}

async function readApplied(db: Db): Promise<AppliedRow[] | null> {
  const [tables] = (await db.execute(
    sql`select count(*) as n from information_schema.tables where table_schema = database() and table_name = ${MIGRATIONS_TABLE}`,
  )) as unknown as [{ n: number | string }[]];
  if (Number(tables[0]?.n ?? 0) === 0) return null;
  const [rows] = (await db.execute(
    sql`select hash, created_at from ${sql.identifier(MIGRATIONS_TABLE)} order by created_at asc, id asc limit 10001`,
  )) as unknown as [AppliedRow[]];
  return rows;
}

export async function computeSchemaStatus(db: Db, migrationsDir: string): Promise<SchemaStatus> {
  let release: ReleaseMigration[];
  try {
    release = await readReleaseMigrations(migrationsDir);
  } catch {
    return { state: "unreadable", releaseCount: 0, appliedCount: 0, lastReleaseTag: null };
  }
  const lastReleaseTag = release.at(-1)?.tag ?? null;
  const applied = (await readApplied(db)) ?? [];
  const status = (state: SchemaStatus["state"]): SchemaStatus => ({
    state,
    releaseCount: release.length,
    appliedCount: applied.length,
    lastReleaseTag,
  });
  const common = Math.min(applied.length, release.length);
  for (let i = 0; i < common; i += 1) {
    const row = applied[i]!;
    const expected = release[i]!;
    if (row.hash !== expected.hash || Number(row.created_at) !== expected.when) return status("unknown");
  }
  if (applied.length > release.length) return status("ahead");
  if (applied.length < release.length) return status("behind");
  return status("current");
}

const REASONS: Record<Exclude<SchemaStatus["state"], "current">, string> = {
  behind: "SCHEMA_BEHIND",
  ahead: "SCHEMA_AHEAD",
  unknown: "SCHEMA_UNKNOWN",
  unreadable: "SCHEMA_JOURNAL_UNREADABLE",
};

export function schemaContractError(status: SchemaStatus): DomainError | null {
  if (status.state === "current") return null;
  return new DomainError("UNAVAILABLE", REASONS[status.state], "The database schema does not match this release.", {
    releaseCount: status.releaseCount,
    appliedCount: status.appliedCount,
    lastReleaseTag: status.lastReleaseTag ?? "none",
  });
}
