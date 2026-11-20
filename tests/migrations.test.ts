/**
 * Schema contract: the committed migrations must produce exactly the schema the application code declares.
 * A module that changes its Drizzle schema without `pnpm db:generate` fails here (and in the CI drift check).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createTestDb, type TestDb } from "./helpers/testDb.js";

const migrationsFolder = path.resolve(import.meta.dirname, "../migrations");
const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
const statementsOf = (tag: string) =>
  readFileSync(path.join(migrationsFolder, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.replace(/^\s*--.*$/gm, "").trim() !== "");

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
      expect((rows as { n: number }[])[0]?.n).toBe(journal.entries.length);
    } finally {
      connection.release();
    }
  });

  it("0001 upgrades a baseline database that already holds orders and catalog rows", async () => {
    const upgraded = await createTestDb({ schema: {} });
    try {
      const connection = await upgraded.pool.getConnection();
      try {
        for (const statement of statementsOf("0000_baseline")) await connection.query(statement);
        await connection.query("SET FOREIGN_KEY_CHECKS = 0");
        await connection.query(
          "INSERT INTO `orders` (`public_id`,`reference`,`owner_user_id`,`project_name`,`workflow_version_id`,`status_key`,`total_minor`,`currency`) VALUES ('01AAAAAAAAAAAAAAAAAAAAAAAA','RP-TEST-000001',1,'Existing order',1,'submitted',2500,'USD')",
        );
        await connection.query(
          "INSERT INTO `catalog_product_versions` (`public_id`,`product_id`,`version_number`,`name`,`features`,`price_minor`,`currency`) VALUES ('01BBBBBBBBBBBBBBBBBBBBBBBB',1,1,'Existing product',JSON_ARRAY('a'),2500,'USD')",
        );
        await connection.query(
          "INSERT INTO `order_line_items` (`public_id`,`order_id`,`name`,`features`,`unit_price_minor`,`currency`,`quantity`,`line_total_minor`) VALUES ('01CCCCCCCCCCCCCCCCCCCCCCCC',1,'Existing item',JSON_ARRAY('a'),2500,'USD',1,2500)",
        );
        await connection.query("SET FOREIGN_KEY_CHECKS = 1");
        for (const statement of statementsOf("0001_offerings_and_production_dispatch")) await connection.query(statement);
        const [orders] = await connection.query("SELECT `subtotal_minor` AS s, `discount_minor` AS d, `total_minor` AS t, `discount_label` AS l FROM `orders`");
        expect((orders as { s: number | string; d: number | string; t: number | string; l: string | null }[]).map((r) => [Number(r.s), Number(r.d), Number(r.t), r.l])).toEqual([[2500, 0, 2500, null]]);
        const [versions] = await connection.query("SELECT JSON_LENGTH(`deliverables`) AS n, `outcome` AS o, `timeline` AS tl FROM `catalog_product_versions`");
        expect(versions).toEqual([{ n: 0, o: "", tl: "" }]);
        const [items] = await connection.query("SELECT JSON_LENGTH(`deliverables`) AS n, `packet_number` AS p, `tier` AS t FROM `order_line_items`");
        expect(items).toEqual([{ n: 0, p: null, t: null }]);
      } finally {
        connection.release();
      }
      // The upgraded database has exactly the declared shape.
      const want = await describeSchema(declared);
      const got = await describeSchema(upgraded);
      expect(got.columns).toEqual(want.columns);
      expect(got.indexes).toEqual(want.indexes);
    } finally {
      await upgraded.cleanup();
    }
  }, 120_000);

  it("include the security-relevant columns later code depends on", async () => {
    const [rows] = await migrated.pool.query(
      `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND COLUMN_NAME IN ('totp_failures','totp_locked_until','interruption_pending')`,
      [migrated.name],
    );
    expect((rows as { c: string }[]).map((r) => r.c).sort()).toEqual(["interruption_pending", "totp_failures", "totp_locked_until"]);
  });
});
