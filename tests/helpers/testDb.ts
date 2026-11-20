/**
 * Isolated MySQL test databases built from the Drizzle schema (no migration files needed).
 *
 *   const t = await createTestDb({ schema: { users, orders, ... } });   // or omit schema for ALL tables
 *   afterAll(() => t.cleanup());
 *
 * Each call creates a fresh `rp_test_<random>` database on the local dev MySQL (RP_DEV_MYSQL_URL) and drops
 * it on cleanup. Pass only the tables your module needs (plus `users`) so other modules' in-progress schema
 * edits cannot break your tests. SYNTHETIC data only.
 */
import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import type { Db } from "../../server/core/types.js";

export interface TestDb {
  db: Db;
  pool: mysql.Pool;
  name: string;
  url: string;
  cleanup(): Promise<void>;
}

const baseUrl = () => process.env.RP_DEV_MYSQL_URL ?? "mysql://rp_dev:rp_dev_local_only@127.0.0.1:3306";

export async function createTestDb(options: { schema?: Record<string, unknown> } = {}): Promise<TestDb> {
  const schema = options.schema ?? ((await import("../../server/db/schema/index.js")) as Record<string, unknown>);
  const { generateMySQLDrizzleJson, generateMySQLMigration } = await import("drizzle-kit/api");
  const name = `rp_test_${randomBytes(6).toString("hex")}`;
  const admin = await mysql.createConnection({ uri: baseUrl(), multipleStatements: false });
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await admin.end();
  const url = `${baseUrl()}/${name}`;
  const pool = mysql.createPool({ uri: url, connectionLimit: 6, timezone: "Z", supportBigNumbers: true, charset: "utf8mb4" });
  try {
    const empty = await generateMySQLDrizzleJson({});
    const target = await generateMySQLDrizzleJson(schema);
    const statements = await generateMySQLMigration(empty, target);
    const connection = await pool.getConnection();
    try {
      await connection.query("SET FOREIGN_KEY_CHECKS = 0");
      for (const statement of statements) await connection.query(statement);
      await connection.query("SET FOREIGN_KEY_CHECKS = 1");
    } finally {
      connection.release();
    }
  } catch (error) {
    await pool.end();
    await dropDatabase(name);
    throw error;
  }
  const db = drizzle(pool, { mode: "default" }) as unknown as Db;
  return {
    db,
    pool,
    name,
    url,
    async cleanup() {
      await pool.end();
      await dropDatabase(name);
    },
  };
}

async function dropDatabase(name: string): Promise<void> {
  if (!/^rp_test_[0-9a-f]{12}$/.test(name)) throw new Error("refusing to drop a non-test database");
  const admin = await mysql.createConnection({ uri: baseUrl() });
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.end();
}
