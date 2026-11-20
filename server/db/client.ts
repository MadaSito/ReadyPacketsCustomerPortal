import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import type { Db } from "../core/types.js";
import { connectionOptionsFromUrl } from "./connectionOptions.js";

export interface DatabaseHandle {
  db: Db;
  pool: mysql.Pool;
  close(): Promise<void>;
}

/**
 * Creates the pooled connection. All sessions run in UTC with strict SQL mode; `multipleStatements`
 * stays disabled so a single query can never smuggle a second statement.
 */
export function createDatabase(url: string, poolSize = 10): DatabaseHandle {
  const pool = mysql.createPool({
    // Options are built from allow-listed URL components; the URL itself never reaches the driver.
    ...connectionOptionsFromUrl(url),
    connectionLimit: poolSize,
    waitForConnections: true,
    queueLimit: 200,
    enableKeepAlive: true,
  });
  pool.on("connection", (connection) => {
    connection.query(
      "SET SESSION time_zone = '+00:00', sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,ONLY_FULL_GROUP_BY'",
    );
  });
  const db = drizzle(pool, { mode: "default" }) as unknown as Db;
  return { db, pool, close: () => pool.end() };
}
