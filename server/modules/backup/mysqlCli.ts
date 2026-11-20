/**
 * Safe MySQL binary (`mysqldump` / `mysql`) invocation and schema/snapshot introspection.
 *
 * Security invariants:
 *  - NEVER passes a password on argv or in an environment variable (`MYSQL_PWD` is forbidden).
 *  - NEVER uses a shell (`spawn` with explicit argument arrays and `shell: false`).
 *  - Credentials are written to an ephemeral `0600` `defaults-extra-file` inside an ephemeral `0700`
 *    directory opened with `O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW` and unlinked in `finally`.
 *  - Error messages never echo connection URLs, usernames, passwords, hostnames, or raw SQL stderr.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import mysql from "mysql2/promise";
import { conflict, CryptoError, DomainError, validation } from "../../core/errors.js";

const DB_NAME_PATTERN = /^[a-zA-Z0-9_]{3,64}$/;
const SYSTEM_DATABASES = new Set(["mysql", "information_schema", "performance_schema", "sys"]);

export interface ParsedMysqlUrl {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** Base server URI without a database path (`mysql://user:pass@host:port`). */
  serverBaseUri: string;
}

export function parseMysqlUrl(databaseUrl: string): ParsedMysqlUrl {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new DomainError("UNAVAILABLE", "DATABASE_URL_INVALID", "Database connection configuration is invalid.");
  }
  if (parsed.protocol !== "mysql:") {
    throw new DomainError("UNAVAILABLE", "DATABASE_URL_INVALID", "Database connection must use mysql protocol.");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!DB_NAME_PATTERN.test(database)) {
    throw new DomainError("UNAVAILABLE", "DATABASE_NAME_INVALID", "Configured database name is invalid.");
  }
  const host = parsed.hostname || "127.0.0.1";
  const port = parsed.port ? Number(parsed.port) : 3306;
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const serverUrl = new URL(databaseUrl);
  serverUrl.pathname = "";
  serverUrl.search = "";
  serverUrl.hash = "";
  return {
    host,
    port,
    user,
    password,
    database,
    serverBaseUri: serverUrl.toString().replace(/\/$/, ""),
  };
}

/** Escapes a value for a MySQL `[client]` option file (`"` quoted, escaping `\`, `"`, `\n`, `\r`). */
function escapeMysqlOptionValue(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

async function createDefaultsExtraFile(conn: ParsedMysqlUrl): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "rp-mysql-cnf-"));
  const filePath = path.join(dir, "client.cnf");
  const lines = [
    "[client]",
    `host=${escapeMysqlOptionValue(conn.host)}`,
    `port=${String(conn.port)}`,
    `user=${escapeMysqlOptionValue(conn.user)}`,
    `password=${escapeMysqlOptionValue(conn.password)}`,
    "default-character-set=utf8mb4",
    "",
  ];
  const handle = await open(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(lines.join("\n"), { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }

  let cleaned = false;
  return {
    filePath,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await unlink(filePath).catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

export interface DatabaseSnapshotMetadata {
  migrationCount: number;
  lastMigrationHash: string | null;
  lastMigrationCreatedAt: number | null;
  tableNames: string[];
  tableRowCounts: Record<string, number>;
}

/**
 * Reads consistent table inventory, exact row counts, and Drizzle migration journal state inside a
 * `REPEATABLE READ` consistent snapshot transaction.
 */
export async function inspectDatabaseSnapshot(databaseUrl: string): Promise<DatabaseSnapshotMetadata> {
  const parsed = parseMysqlUrl(databaseUrl);
  const connection = await mysql.createConnection({
    uri: databaseUrl,
    multipleStatements: false,
    timezone: "Z",
    supportBigNumbers: true,
  });
  try {
    await connection.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");

    const [tableRows] = await connection.query(
      "SELECT TABLE_NAME AS tableName FROM information_schema.tables WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME ASC",
      [parsed.database],
    );
    const tableNames = (tableRows as { tableName: string }[])
      .map((r) => r.tableName)
      .filter((name) => DB_NAME_PATTERN.test(name));

    const tableRowCounts: Record<string, number> = {};
    for (const tableName of tableNames) {
      const [cntRows] = await connection.query(`SELECT COUNT(*) AS cnt FROM \`${tableName}\``);
      tableRowCounts[tableName] = Number((cntRows as { cnt: number | string }[])[0]?.cnt ?? 0);
    }

    let migrationCount = 0;
    let lastMigrationHash: string | null = null;
    let lastMigrationCreatedAt: number | null = null;
    if (tableNames.includes("__drizzle_migrations")) {
      const [migRows] = await connection.query(
        "SELECT hash, created_at AS createdAt FROM `__drizzle_migrations` ORDER BY id ASC",
      );
      const list = migRows as { hash: string; createdAt: number | string }[];
      migrationCount = list.length;
      if (list.length > 0) {
        const last = list[list.length - 1]!;
        lastMigrationHash = String(last.hash);
        lastMigrationCreatedAt = Number(last.createdAt);
      }
    }

    await connection.query("COMMIT");
    return {
      migrationCount,
      lastMigrationHash,
      lastMigrationCreatedAt,
      tableNames,
      tableRowCounts,
    };
  } finally {
    await connection.end();
  }
}

export interface MysqldumpStreamHandle {
  gzStream: Readable;
  snapshot: DatabaseSnapshotMetadata;
  startedAt: Date;
  finalize: () => Promise<{
    uncompressedBytes: number;
    uncompressedSha256: string;
    completedAt: Date;
  }>;
}

/**
 * Spawns `mysqldump` with `--defaults-extra-file` (0600) and `--single-transaction`, streaming stdout
 * directly through a SHA-256 meter and gzip compressor with zero plaintext temporary files.
 */
export async function openMysqldumpGzStream(
  databaseUrl: string,
  now: () => Date,
): Promise<MysqldumpStreamHandle> {
  const conn = parseMysqlUrl(databaseUrl);
  const snapshot = await inspectDatabaseSnapshot(databaseUrl);
  const cnf = await createDefaultsExtraFile(conn);
  const startedAt = now();

  const args = [
    `--defaults-extra-file=${cnf.filePath}`,
    "--single-transaction",
    "--quick",
    "--routines",
    "--triggers",
    "--events",
    "--hex-blob",
    "--set-gtid-purged=OFF",
    "--no-tablespaces",
    "--skip-Lock-tables",
    conn.database,
  ];
  // Normalize flag casing for MySQL 8.4 mysqldump (`--skip-lock-tables`)
  args[args.length - 2] = "--skip-lock-tables";

  const child = spawn("mysqldump", args, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: "/usr/bin:/bin:/usr/local/bin",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
    },
  });

  let stderrChunks = 0;
  child.stderr.on("data", () => {
    stderrChunks += 1;
  });

  const exitPromise = new Promise<void>((resolve, reject) => {
    child.once("error", (err) => {
      void cnf.cleanup();
      const code = (err as NodeJS.ErrnoException).code;
      reject(
        new DomainError(
          "UNAVAILABLE",
          code === "ENOENT" ? "MYSQLDUMP_BINARY_MISSING" : "MYSQLDUMP_SPAWN_FAILED",
          "Database dump tool could not be started.",
        ),
      );
    });
    child.once("close", (exitCode, signal) => {
      void cnf.cleanup();
      if (exitCode === 0 && !signal) {
        resolve();
      } else {
        reject(
          new DomainError(
            "UNAVAILABLE",
            "MYSQLDUMP_FAILED",
            "Logical database dump failed before completion.",
            { exitCode: exitCode ?? -1, hadStderr: stderrChunks > 0 },
          ),
        );
      }
    });
  });

  let uncompressedBytes = 0;
  const rawHash = createHash("sha256");
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      uncompressedBytes += chunk.length;
      rawHash.update(chunk);
      cb(null, chunk);
    },
  });

  const gzip = createGzip({ level: 6 });
  child.stdout.pipe(meter).pipe(gzip);
  child.stdout.on("error", (err) => gzip.destroy(err));
  meter.on("error", (err) => gzip.destroy(err));

  return {
    gzStream: gzip,
    snapshot,
    startedAt,
    async finalize() {
      await exitPromise;
      if (uncompressedBytes === 0) {
        throw new DomainError("UNAVAILABLE", "MYSQLDUMP_EMPTY", "Database dump produced zero bytes.");
      }
      return {
        uncompressedBytes,
        uncompressedSha256: rawHash.digest("hex"),
        completedAt: now(),
      };
    },
  };
}

/**
 * Verifies compressed gzip SQL member without touching any database: decompresses in memory, checks
 * uncompressed byte count, SHA-256 digest, and SQL dump header/footer markers.
 */
export async function verifySqlGzStream(
  gzChunks: AsyncIterable<Buffer>,
  expected: { uncompressedBytes: number; uncompressedSha256: string },
): Promise<void> {
  const rawHash = createHash("sha256");
  let uncompressedBytes = 0;
  let headSample = "";
  let tailWindow = "";

  const gunzip = createGunzip();
  const sink = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      uncompressedBytes += chunk.length;
      rawHash.update(chunk);
      const text = chunk.toString("utf8");
      if (headSample.length < 512) {
        headSample += text.slice(0, 512 - headSample.length);
      }
      tailWindow = (tailWindow + text).slice(-512);
      cb();
    },
  });

  try {
    await pipeline(Readable.from(gzChunks), gunzip, sink);
  } catch {
    throw new CryptoError("TAMPERED");
  }

  const actualSha = rawHash.digest("hex");
  if (uncompressedBytes !== expected.uncompressedBytes || actualSha !== expected.uncompressedSha256) {
    throw new CryptoError("TAMPERED");
  }
  if (!headSample.includes("MySQL dump") || !tailWindow.includes("Dump completed")) {
    throw new CryptoError("MALFORMED");
  }
}

export function assertValidIsolatedDatabaseName(liveDatabaseUrl: string, targetDatabaseName: string): ParsedMysqlUrl {
  if (!DB_NAME_PATTERN.test(targetDatabaseName) || targetDatabaseName !== targetDatabaseName.toLowerCase()) {
    throw validation(
      "INVALID_TARGET_DATABASE",
      "Target database name must be 3-64 lowercase alphanumeric or underscore characters.",
    );
  }
  if (SYSTEM_DATABASES.has(targetDatabaseName)) {
    throw conflict("TARGET_DATABASE_FORBIDDEN", "Cannot restore into a MySQL system schema.");
  }
  const live = parseMysqlUrl(liveDatabaseUrl);
  if (targetDatabaseName.toLowerCase() === live.database.toLowerCase()) {
    throw conflict(
      "LIVE_TARGET_REFUSED",
      "Restore into the live database is refused; supply a separate isolated target database.",
    );
  }
  return live;
}

/**
 * Ensures the isolated target database either does not exist yet (creates it) or exists with 0 tables.
 * Refuses populated databases (`TARGET_DATABASE_NOT_EMPTY`).
 */
export async function prepareIsolatedTargetDatabase(
  liveDatabaseUrl: string,
  targetDatabaseName: string,
): Promise<{ targetDatabaseUrl: string; createdDatabase: boolean }> {
  const live = assertValidIsolatedDatabaseName(liveDatabaseUrl, targetDatabaseName);
  const admin = await mysql.createConnection({
    uri: live.serverBaseUri,
    multipleStatements: false,
    timezone: "Z",
  });
  try {
    const [schemaRows] = await admin.query(
      "SELECT SCHEMA_NAME AS name FROM information_schema.schemata WHERE LOWER(SCHEMA_NAME) = LOWER(?)",
      [targetDatabaseName],
    );
    const exists = (schemaRows as { name: string }[]).length > 0;
    if (exists) {
      const [tblRows] = await admin.query(
        "SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE LOWER(TABLE_SCHEMA) = LOWER(?)",
        [targetDatabaseName],
      );
      const count = Number((tblRows as { cnt: number | string }[])[0]?.cnt ?? 0);
      if (count > 0) {
        throw conflict(
          "TARGET_DATABASE_NOT_EMPTY",
          "Target database already contains tables; restore requires an empty isolated database.",
        );
      }
    } else {
      await admin.query(
        `CREATE DATABASE \`${targetDatabaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
      );
    }
    return {
      targetDatabaseUrl: `${live.serverBaseUri}/${encodeURIComponent(targetDatabaseName)}`,
      createdDatabase: !exists,
    };
  } finally {
    await admin.end();
  }
}

/**
 * Streams a verified gzipped SQL dump into `mysql` against the isolated target database, re-checking
 * uncompressed SHA-256 on the fly.
 */
export async function loadSqlGzIntoIsolatedDatabase(
  targetDatabaseUrl: string,
  gzChunks: AsyncIterable<Buffer>,
  expected: { uncompressedBytes: number; uncompressedSha256: string },
): Promise<void> {
  const conn = parseMysqlUrl(targetDatabaseUrl);
  const cnf = await createDefaultsExtraFile(conn);

  const child = spawn(
    "mysql",
    [
      `--defaults-extra-file=${cnf.filePath}`,
      "--default-character-set=utf8mb4",
      "--binary-mode=1",
      conn.database,
    ],
    {
      shell: false,
      stdio: ["pipe", "ignore", "pipe"],
      env: {
        PATH: "/usr/bin:/bin:/usr/local/bin",
        LC_ALL: "C.UTF-8",
        TZ: "UTC",
      },
    },
  );

  let stderrChunks = 0;
  child.stderr.on("data", () => {
    stderrChunks += 1;
  });

  const exitPromise = new Promise<void>((resolve, reject) => {
    child.once("error", (err) => {
      void cnf.cleanup();
      const code = (err as NodeJS.ErrnoException).code;
      reject(
        new DomainError(
          "UNAVAILABLE",
          code === "ENOENT" ? "MYSQL_BINARY_MISSING" : "MYSQL_SPAWN_FAILED",
          "Database client tool could not be started.",
        ),
      );
    });
    child.once("close", (exitCode, signal) => {
      void cnf.cleanup();
      if (exitCode === 0 && !signal) {
        resolve();
      } else {
        reject(
          new DomainError(
            "UNAVAILABLE",
            "MYSQL_RESTORE_FAILED",
            "Applying the SQL snapshot to the isolated database failed.",
            { exitCode: exitCode ?? -1, hadStderr: stderrChunks > 0 },
          ),
        );
      }
    });
  });

  const rawHash = createHash("sha256");
  let uncompressedBytes = 0;
  const gunzip = createGunzip();
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      uncompressedBytes += chunk.length;
      rawHash.update(chunk);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(Readable.from(gzChunks), gunzip, meter, child.stdin);
    await exitPromise;
  } catch (error) {
    child.kill("SIGTERM");
    await cnf.cleanup();
    if (error instanceof DomainError || error instanceof CryptoError) throw error;
    throw new DomainError("UNAVAILABLE", "MYSQL_RESTORE_STREAM_FAILED", "SQL snapshot stream failed during isolated restore.");
  }

  if (uncompressedBytes !== expected.uncompressedBytes || rawHash.digest("hex") !== expected.uncompressedSha256) {
    throw new CryptoError("TAMPERED");
  }
}
