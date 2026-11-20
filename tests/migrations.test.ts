/**
 * Schema contract: the committed migrations must produce exactly the schema the application code declares.
 * A module that changes its Drizzle schema without `pnpm db:generate` fails here (and in the CI drift check).
 */
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createTestDb, type TestDb } from "./helpers/testDb.js";

const migrationsFolder = path.resolve(import.meta.dirname, "../migrations");

async function describeSchema(t: TestDb) {
  const [columns] = await t.pool.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS ty, IS_NULLABLE AS n, COLUMN_DEFAULT AS d, EXTRA AS e, COLLATION_NAME AS co
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> '__drizzle_migrations'
      ORDER BY TABLE_NAME, COLUMN_NAME`,
    [t.name],
  );
  const [indexes] = await t.pool.query(
    `SELECT TABLE_NAME AS t, INDEX_NAME AS i, NON_UNIQUE AS nu, SEQ_IN_INDEX AS s, COLUMN_NAME AS c
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> '__drizzle_migrations'
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [t.name],
  );
  const [foreignKeys] = await t.pool.query(
    `SELECT k.TABLE_NAME AS t, k.CONSTRAINT_NAME AS k, k.COLUMN_NAME AS c, k.REFERENCED_TABLE_NAME AS rt, k.REFERENCED_COLUMN_NAME AS rc,
            r.UPDATE_RULE AS u, r.DELETE_RULE AS d
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
      WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    [t.name],
  );
  return { columns, indexes, foreignKeys };
}

describe("migrations", () => {
  let declared: TestDb;
  let migrated: TestDb;

  beforeAll(async () => {
    declared = await createTestDb();
    migrated = await createTestDb({ schema: {} });
    const connection = await migrated.pool.getConnection();
    try {
      await migrate(drizzle(connection), { migrationsFolder });
    } finally {
      connection.release();
    }
  }, 120_000);

  afterAll(async () => {
    await declared?.cleanup();
    await migrated?.cleanup();
  });

  it("produce the same tables, columns, indexes and foreign keys as the declared schema", async () => {
    const want = await describeSchema(declared);
    const got = await describeSchema(migrated);
    expect((got.columns as unknown[]).length).toBeGreaterThan(400);
    expect(got.columns).toEqual(want.columns);
    expect(got.indexes).toEqual(want.indexes);
    expect(got.foreignKeys).toEqual(want.foreignKeys);
  });

  it("are idempotent when applied again", async () => {
    const connection = await migrated.pool.getConnection();
    try {
      await migrate(drizzle(connection), { migrationsFolder });
      const [rows] = await connection.query("SELECT COUNT(*) AS n FROM `__drizzle_migrations`");
      expect((rows as { n: number }[])[0]?.n).toBe(1);
    } finally {
      connection.release();
    }
  });

  it("include the security-relevant columns later code depends on", async () => {
    const [rows] = await migrated.pool.query(
      `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND COLUMN_NAME IN ('totp_failures','totp_locked_until','interruption_pending')`,
      [migrated.name],
    );
    expect((rows as { c: string }[]).map((r) => r.c).sort()).toEqual(["interruption_pending", "totp_failures", "totp_locked_until"]);
  });
});
