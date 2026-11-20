/**
 * Safe MySQL binary (`mysqldump` / `mysql`) invocation, shared TLS policy enforcement, and streaming snapshot
 * introspection. Owner: recovery_ops_engineer.
 *
 * Security invariants:
 *  - Every `mysql2` connection is built exclusively via `connectionOptionsFromUrl` (`server/db/connectionOptions.ts`),
 *    never by passing raw DSN strings to the driver. TLS (`?tls=required&tlsCaFile=/abs/path.pem`), hostname identity
 *    verification, `TLSv1.2+`, `multipleStatements: false`, and `-LOCAL_FILES` are enforced uniformly.
 *  - Every `mysqldump` / `mysql` child process passes `--defaults-file=<0600-ephemeral-file>` as its FIRST argument
 *    so ambient `/etc/my.cnf`, `/etc/mysql/*`, `$MYSQL_HOME`, and `~/.my.cnf` files are ignored.
 *  - `[client]` explicitly sets `local-infile=0`, and when `tls=required` sets `ssl-mode=VERIFY_IDENTITY`,
 *    `tls-version=TLSv1.2,TLSv1.3`, and optional `ssl-ca="..."`.
 *  - Passwords are NEVER passed on `argv` or in environment variables (`MYSQL_PWD` is forbidden).
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
import mysql, { type ConnectionOptions } from "mysql2/promise";
import { conflict, CryptoError, DomainError, validation } from "../../core/errors.js";
import { connectionOptionsFromUrl, DatabaseUrlError } from "../../db/connectionOptions.js";

const DB_NAME_PATTERN = /^[a-zA-Z0-9_]{3,64}$/;
const SYSTEM_DATABASES = new Set(["mysql", "information_schema", "performance_schema", "sys"]);

export interface ValidatedMysqlTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  tlsRequired: boolean;
  tlsCaFile: string | null;
  driverOptions: ConnectionOptions;
  /** Builds a sibling DSN on the same endpoint & credentials, preserving all validated TLS query parameters. */
  withDatabase(targetDatabaseName: string): string;
}

export function parseValidatedMysqlTarget(databaseUrl: string): ValidatedMysqlTarget {
  let driverOptions: ConnectionOptions;
  try {
    driverOptions = connectionOptionsFromUrl(databaseUrl);
  } catch (error) {
    if (error instanceof DatabaseUrlError) {
      throw new DomainError("UNAVAILABLE", "DATABASE_URL_INVALID", error.message);
    }
    throw new DomainError("UNAVAILABLE", "DATABASE_URL_INVALID", "Database connection configuration is invalid.");
  }

  const parsed = new URL(databaseUrl);
  const database = String(driverOptions.database ?? "");
  if (!DB_NAME_PATTERN.test(database)) {
    throw new DomainError("UNAVAILABLE", "DATABASE_NAME_INVALID", "Configured database name is invalid.");
  }
  const tlsRequired = parsed.searchParams.get("tls") === "required";
  const tlsCaFile = parsed.searchParams.get("tlsCaFile");

  return {
    host: String(driverOptions.host),
    port: Number(driverOptions.port ?? 3306),
    user: String(driverOptions.user ?? ""),
    password: String(driverOptions.password ?? ""),
    database,
    tlsRequired,
    tlsCaFile: tlsCaFile ?? null,
    driverOptions,
    withDatabase(targetDatabaseName: string): string {
      const derived = new URL(databaseUrl);
      derived.pathname = `/${encodeURIComponent(targetDatabaseName)}`;
      const candidate = derived.toString();
      // Re-validate derived URL through the central allow-list parser.
      connectionOptionsFromUrl(candidate);
      return candidate;
    },
  };
}

/** Opens a `mysql2` connection strictly via `connectionOptionsFromUrl` (optionally omitting `database` for server-level checks). */
export async function openValidatedMysqlConnection(
  databaseUrl: string,
  options?: { withoutDatabase?: boolean },
): Promise<mysql.Connection> {
  const validated = parseValidatedMysqlTarget(databaseUrl);
  const connOpts: ConnectionOptions = { ...validated.driverOptions };
  if (options?.withoutDatabase) {
    delete connOpts.database;
  }
  const conn = await mysql.createConnection(connOpts);
  await conn.query(
    "SET SESSION time_zone = '+00:00', sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,ONLY_FULL_GROUP_BY'",
  );
  return conn;
}

/** Opens a `mysql2` pool strictly via `connectionOptionsFromUrl`. */
export function openValidatedMysqlPool(databaseUrl: string, poolSize = 2): mysql.Pool {
  const validated = parseValidatedMysqlTarget(databaseUrl);
  const pool = mysql.createPool({
    ...validated.driverOptions,
    connectionLimit: poolSize,
    waitForConnections: true,
    queueLimit: 32,
    enableKeepAlive: true,
  });
  pool.on("connection", (connection) => {
    connection.query(
      "SET SESSION time_zone = '+00:00', sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,ONLY_FULL_GROUP_BY'",
    );
  });
  return pool;
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

export async function createPrivateDefaultsFile(
  conn: ValidatedMysqlTarget,
): Promise<{ filePath: string; dirPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "rp-mysql-cnf-"));
  const filePath = path.join(dir, "client.cnf");
  const lines = [
    "[client]",
    "protocol=TCP",
    `host=${escapeMysqlOptionValue(conn.host)}`,
    `port=${String(conn.port)}`,
    `user=${escapeMysqlOptionValue(conn.user)}`,
    `password=${escapeMysqlOptionValue(conn.password)}`,
    "default-character-set=utf8mb4",
  ];
  if (conn.tlsRequired) {
    lines.push("ssl-mode=VERIFY_IDENTITY");
    lines.push("tls-version=TLSv1.2,TLSv1.3");
    if (conn.tlsCaFile) {
      lines.push(`ssl-ca=${escapeMysqlOptionValue(conn.tlsCaFile)}`);
    }
  }
  lines.push("");
  lines.push("[mysql]");
  lines.push("local-infile=0");
  lines.push("");

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
    dirPath: dir,
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
 * `REPEATABLE READ` consistent snapshot transaction on an isolated target database after restore.
 */
export async function inspectDatabaseSnapshot(databaseUrl: string): Promise<DatabaseSnapshotMetadata> {
  const parsed = parseValidatedMysqlTarget(databaseUrl);
  const connection = await openValidatedMysqlConnection(databaseUrl);
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

/**
 * Chunk-boundary-safe streaming SQL parser for `mysqldump --hex-blob` output.
 * Extracts exact `tableNames`, exact `tableRowCounts`, and `__drizzle_migrations` journal metadata directly
 * from the single `mysqldump --single-transaction` snapshot stream so the manifest never diverges from the dump
 * under concurrent writes.
 */
class StreamingDumpInspector {
  private mode: "line_start" | "skip_line" | "insert_values" = "line_start";
  private linePrefix = "";
  private currentTable: string | null = null;
  private parenDepth = 0;
  private inSingleQuote = false;
  private escapeNext = false;
  private readonly tableCounts = new Map<string, number>();
  private migrationSqlChunks: string[] = [];
  private migrationBytes = 0;

  feed(chunk: Buffer): void {
    for (let i = 0; i < chunk.length; i += 1) {
      const byte = chunk[i]!;

      if (this.mode === "insert_values") {
        if (this.currentTable === "__drizzle_migrations" && this.migrationBytes < 262_144) {
          this.migrationSqlChunks.push(String.fromCharCode(byte));
          this.migrationBytes += 1;
        }
        if (this.escapeNext) {
          this.escapeNext = false;
          continue;
        }
        if (this.inSingleQuote) {
          if (byte === 0x5c /* \ */) {
            this.escapeNext = true;
          } else if (byte === 0x27 /* ' */) {
            this.inSingleQuote = false;
          }
          continue;
        }
        if (byte === 0x27 /* ' */) {
          this.inSingleQuote = true;
        } else if (byte === 0x28 /* ( */) {
          if (this.parenDepth === 0 && this.currentTable) {
            this.tableCounts.set(this.currentTable, (this.tableCounts.get(this.currentTable) ?? 0) + 1);
          }
          this.parenDepth += 1;
        } else if (byte === 0x29 /* ) */) {
          if (this.parenDepth > 0) this.parenDepth -= 1;
        } else if (byte === 0x3b /* ; */ && this.parenDepth === 0) {
          if (this.currentTable === "__drizzle_migrations") {
            this.migrationSqlChunks.push("\n");
          }
          this.currentTable = null;
          this.mode = "skip_line";
        }
        continue;
      }

      if (this.mode === "skip_line") {
        if (this.escapeNext) {
          this.escapeNext = false;
          continue;
        }
        if (this.inSingleQuote) {
          if (byte === 0x5c) this.escapeNext = true;
          else if (byte === 0x27) this.inSingleQuote = false;
          continue;
        }
        if (byte === 0x27) {
          this.inSingleQuote = true;
        } else if (byte === 0x0a /* \n */) {
          this.mode = "line_start";
          this.linePrefix = "";
        }
        continue;
      }

      // mode === "line_start"
      if (byte === 0x0a /* \n */) {
        this.linePrefix = "";
        continue;
      }
      if (this.linePrefix.length < 160) {
        this.linePrefix += String.fromCharCode(byte);
        if (byte === 0x28 /* ( */) {
          const createMatch = /^CREATE TABLE `([A-Za-z0-9_]{1,64})` \(/.exec(this.linePrefix);
          if (createMatch) {
            const tbl = createMatch[1]!;
            if (!this.tableCounts.has(tbl)) {
              this.tableCounts.set(tbl, 0);
            }
            this.mode = "skip_line";
            continue;
          }
          const insertMatch = /^INSERT INTO `([A-Za-z0-9_]{1,64})` VALUES \(/.exec(this.linePrefix);
          if (insertMatch) {
            const tbl = insertMatch[1]!;
            this.currentTable = tbl;
            this.tableCounts.set(tbl, (this.tableCounts.get(tbl) ?? 0) + 1);
            this.parenDepth = 1;
            this.inSingleQuote = false;
            this.escapeNext = false;
            if (tbl === "__drizzle_migrations" && this.migrationBytes < 262_144) {
              this.migrationSqlChunks.push("(");
              this.migrationBytes += 1;
            }
            this.mode = "insert_values";
            continue;
          }
          this.mode = "skip_line";
        }
      } else {
        this.mode = "skip_line";
      }
    }
  }

  snapshot(): DatabaseSnapshotMetadata {
    const tableNames = [...this.tableCounts.keys()].sort();
    const tableRowCounts: Record<string, number> = {};
    for (const name of tableNames) {
      tableRowCounts[name] = this.tableCounts.get(name) ?? 0;
    }

    let migrationCount = tableRowCounts["__drizzle_migrations"] ?? 0;
    let lastMigrationHash: string | null = null;
    let lastMigrationCreatedAt: number | null = null;
    if (this.migrationSqlChunks.length > 0) {
      const migText = this.migrationSqlChunks.join("");
      const tupleRe = /\((\d+),'([^']*)',(\d+)\)/g;
      const parsedRows: { id: number; hash: string; createdAt: number }[] = [];
      let m: RegExpExecArray | null;
      while ((m = tupleRe.exec(migText)) !== null) {
        parsedRows.push({ id: Number(m[1]), hash: m[2]!, createdAt: Number(m[3]) });
      }
      if (parsedRows.length > 0) {
        parsedRows.sort((a, b) => a.id - b.id);
        migrationCount = parsedRows.length;
        const last = parsedRows[parsedRows.length - 1]!;
        lastMigrationHash = last.hash;
        lastMigrationCreatedAt = last.createdAt;
      }
    }

    return {
      migrationCount,
      lastMigrationHash,
      lastMigrationCreatedAt,
      tableNames,
      tableRowCounts,
    };
  }
}

export interface MysqldumpStreamHandle {
  gzStream: Readable;
  startedAt: Date;
  /** Resolves once `mysqldump` has emitted its initial header bytes (snapshot transaction established). */
  waitSnapshotStarted: () => Promise<void>;
  finalize: () => Promise<{
    uncompressedBytes: number;
    uncompressedSha256: string;
    snapshot: DatabaseSnapshotMetadata;
    completedAt: Date;
  }>;
}

/**
 * Spawns `mysqldump` with `--defaults-file` (0600, first arg, ignoring ambient my.cnf) and `--single-transaction`
 * plus least-privilege `--skip-triggers --skip-events --skip-routines --no-tablespaces`, streaming stdout directly
 * through the snapshot inspector, SHA-256 meter, and gzip compressor with zero plaintext temporary files.
 */
export async function openMysqldumpGzStream(
  databaseUrl: string,
  now: () => Date,
  abortSignal?: AbortSignal,
): Promise<MysqldumpStreamHandle> {
  if (abortSignal?.aborted) {
    throw new DomainError("CONFLICT", "BACKUP_ABORTED", "Backup aborted before database dump started.");
  }
  const conn = parseValidatedMysqlTarget(databaseUrl);
  const cnf = await createPrivateDefaultsFile(conn);
  const startedAt = now();

  // `--defaults-file` MUST be the very first option, followed immediately by `--no-login-paths` so MySQL 8.4
  // ignores both ambient my.cnf files AND any ~/.mylogin.cnf login-path store; HOME/MYSQL_HOME also isolated.
  const args = [
    `--defaults-file=${cnf.filePath}`,
    "--no-login-paths",
    "--protocol=TCP",
    "--single-transaction",
    "--quick",
    "--skip-triggers",
    "--skip-events",
    "--skip-routines",
    "--hex-blob",
    "--set-gtid-purged=OFF",
    "--no-tablespaces",
    "--skip-lock-tables",
    conn.database,
  ];

  const child = spawn("mysqldump", args, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: "/usr/bin:/bin:/usr/local/bin",
      HOME: cnf.dirPath,
      MYSQL_HOME: cnf.dirPath,
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
    },
  });

  const onAbort = () => {
    child.kill("SIGTERM");
  };
  abortSignal?.addEventListener("abort", onAbort, { once: true });

  let stderrChunks = 0;
  child.stderr.on("data", () => {
    stderrChunks += 1;
  });

  let resolveFirstBytes!: () => void;
  let rejectFirstBytes!: (err: Error) => void;
  let sawFirstBytes = false;
  const firstBytesPromise = new Promise<void>((res, rej) => {
    resolveFirstBytes = res;
    rejectFirstBytes = rej;
  });
  // Prevent unhandled rejection if caller only awaits `finalize()`.
  firstBytesPromise.catch(() => {});

  const exitPromise = new Promise<void>((resolve, reject) => {
    child.once("error", (err) => {
      abortSignal?.removeEventListener("abort", onAbort);
      void cnf.cleanup();
      const code = (err as NodeJS.ErrnoException).code;
      const domainErr = new DomainError(
        "UNAVAILABLE",
        code === "ENOENT" ? "MYSQLDUMP_BINARY_MISSING" : "MYSQLDUMP_SPAWN_FAILED",
        "Database dump tool could not be started.",
      );
      if (!sawFirstBytes) rejectFirstBytes(domainErr);
      reject(domainErr);
    });
    child.once("close", (exitCode, signal) => {
      abortSignal?.removeEventListener("abort", onAbort);
      void cnf.cleanup();
      if (abortSignal?.aborted) {
        const abortErr = new DomainError("CONFLICT", "BACKUP_ABORTED", "Backup aborted while database dump was running.");
        if (!sawFirstBytes) rejectFirstBytes(abortErr);
        reject(abortErr);
        return;
      }
      if (exitCode === 0 && !signal) {
        if (!sawFirstBytes) resolveFirstBytes();
        resolve();
      } else {
        const failErr = new DomainError(
          "UNAVAILABLE",
          "MYSQLDUMP_FAILED",
          "Logical database dump failed before completion.",
          { exitCode: exitCode ?? -1, hadStderr: stderrChunks > 0 },
        );
        if (!sawFirstBytes) rejectFirstBytes(failErr);
        reject(failErr);
      }
    });
  });
  exitPromise.catch(() => {});

  let uncompressedBytes = 0;
  const rawHash = createHash("sha256");
  const inspector = new StreamingDumpInspector();
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!sawFirstBytes && chunk.length > 0) {
        sawFirstBytes = true;
        resolveFirstBytes();
      }
      uncompressedBytes += chunk.length;
      rawHash.update(chunk);
      inspector.feed(chunk);
      cb(null, chunk);
    },
  });

  const gzip = createGzip({ level: 6 });
  child.stdout.pipe(meter).pipe(gzip);
  child.stdout.on("error", (err) => gzip.destroy(err));
  meter.on("error", (err) => gzip.destroy(err));

  return {
    gzStream: gzip,
    startedAt,
    waitSnapshotStarted: () => firstBytesPromise,
    async finalize() {
      await exitPromise;
      if (uncompressedBytes === 0) {
        throw new DomainError("UNAVAILABLE", "MYSQLDUMP_EMPTY", "Database dump produced zero bytes.");
      }
      return {
        uncompressedBytes,
        uncompressedSha256: rawHash.digest("hex"),
        snapshot: inspector.snapshot(),
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

export function assertValidIsolatedDatabaseName(
  recoveryDatabaseUrl: string,
  targetDatabaseName: string,
  liveDatabaseUrl?: string,
): ValidatedMysqlTarget {
  if (!DB_NAME_PATTERN.test(targetDatabaseName) || targetDatabaseName !== targetDatabaseName.toLowerCase()) {
    throw validation(
      "INVALID_TARGET_DATABASE",
      "Target database name must be 3-64 lowercase alphanumeric or underscore characters.",
    );
  }
  if (SYSTEM_DATABASES.has(targetDatabaseName)) {
    throw conflict("TARGET_DATABASE_FORBIDDEN", "Cannot restore into a MySQL system schema.");
  }
  const recovery = parseValidatedMysqlTarget(recoveryDatabaseUrl);
  if (liveDatabaseUrl) {
    const live = parseValidatedMysqlTarget(liveDatabaseUrl);
    if (targetDatabaseName.toLowerCase() === live.database.toLowerCase()) {
      throw conflict(
        "LIVE_TARGET_REFUSED",
        "Restore into the live database is refused; supply a separate isolated target database.",
      );
    }
    if (
      recovery.host.toLowerCase() === live.host.toLowerCase() &&
      recovery.port === live.port &&
      recovery.user === live.user
    ) {
      throw conflict(
        "LIVE_CREDENTIAL_REUSE_REFUSED",
        "Restore refuses to reuse the live application's database credentials; supply dedicated recovery credentials.",
      );
    }
  } else if (targetDatabaseName.toLowerCase() === recovery.database.toLowerCase() && recovery.database === "readypackets") {
    throw conflict(
      "LIVE_TARGET_REFUSED",
      "Restore into the default live database name 'readypackets' is refused; supply an isolated target database name.",
    );
  }
  return recovery;
}

/**
 * Pure grant-line evaluator used by `assertNoLiveSchemaWritePrivilege` so privilege-isolation rules
 * (`*.*` global write/DDL grants and live-schema wildcard grants) are directly unit-testable.
 */
export function assertNoLiveSchemaWritePrivilegeFromGrants(
  grantLines: readonly string[],
  liveDbName: string,
): void {
  const writeKeyword = /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRIGGER|SUPER|SHUTDOWN|FILE)\b/i;

  for (const line of grantLines) {
    // Global `*.*` grant check (ignore `GRANT USAGE ON *.*`).
    if (/ON \*\.\*/i.test(line) && !/^GRANT USAGE ON \*\.\*/i.test(line) && writeKeyword.test(line)) {
      throw conflict(
        "RESTORE_PRIVILEGE_ISOLATION_VIOLATED",
        "Recovery database credentials hold global server write/DDL privileges; use a target-scoped recovery account.",
      );
    }
    // Live schema grant check (`ON \`liveDb\`.*` or wildcard matching `liveDb`).
    const grantMatch = /ON [`'"]?([^`'".\s]+)[`'"]?\.\*\s+TO/i.exec(line);
    if (grantMatch && writeKeyword.test(line)) {
      const pattern = grantMatch[1]!.replace(/\\\\([_%])/g, "\\$1");
      // Convert SQL LIKE pattern (`%` -> `.*`, `_` -> `.`, escaped `\_` -> `_`, `\%` -> `%`) to regex.
      const litUnderscore = "@@RPLITUNDERSCORE@@";
      const litPercent = "@@RPLITPERCENT@@";
      const regexSrc =
        "^" +
        pattern
          .replace(/\\_/g, litUnderscore)
          .replace(/\\%/g, litPercent)
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/%/g, ".*")
          .replace(/_/g, ".")
          .replaceAll(litUnderscore, "_")
          .replaceAll(litPercent, "%") +
        "$";
      if (new RegExp(regexSrc, "i").test(liveDbName)) {
        throw conflict(
          "RESTORE_PRIVILEGE_ISOLATION_VIOLATED",
          "Recovery database credentials hold write/DDL privileges covering the live database; use a target-scoped recovery account.",
        );
      }
    }
  }
}

/**
 * Verifies via `SHOW GRANTS FOR CURRENT_USER()` that when the recovery account connects to the same host/port
 * as `liveDatabaseUrl`, it holds NO global write/DDL privileges and NO write/DDL privileges on the live schema.
 */
async function assertNoLiveSchemaWritePrivilege(
  conn: mysql.Connection,
  liveDbName: string,
): Promise<void> {
  const [rows] = await conn.query("SHOW GRANTS FOR CURRENT_USER()");
  const grantLines = (rows as Record<string, unknown>[]).map((r) => String(Object.values(r)[0] ?? ""));
  assertNoLiveSchemaWritePrivilegeFromGrants(grantLines, liveDbName);
}

export interface ReservedIsolatedDatabase {
  targetDatabaseUrl: string;
  createdDatabase: boolean;
  release: () => Promise<void>;
}

/**
 * Atomically reserves an isolated target database using an exclusive MySQL advisory lock (`GET_LOCK(..., 0)`),
 * enforces live-DB credential & grant isolation, and ensures the target database is either newly created
 * (`CREATE DATABASE` without `IF NOT EXISTS`) or pre-provisioned with 0 tables.
 */
export async function prepareIsolatedTargetDatabase(options: {
  recoveryDatabaseUrl: string;
  targetDatabaseName: string;
  liveDatabaseUrl?: string;
  enforceTargetScopedGrants?: boolean;
}): Promise<ReservedIsolatedDatabase> {
  const { recoveryDatabaseUrl, targetDatabaseName, liveDatabaseUrl } = options;
  const recovery = assertValidIsolatedDatabaseName(recoveryDatabaseUrl, targetDatabaseName, liveDatabaseUrl);

  // Connect without selecting a database first (or selecting target if pre-provisioned).
  let reservationConn: mysql.Connection;
  try {
    reservationConn = await openValidatedMysqlConnection(recoveryDatabaseUrl, { withoutDatabase: true });
  } catch {
    throw new DomainError(
      "UNAVAILABLE",
      "RECOVERY_DB_CONNECT_FAILED",
      "Could not connect to the recovery MySQL endpoint with the supplied credentials.",
    );
  }

  let released = false;
  const lockName = `rp_restore:${targetDatabaseName}`;
  const release = async () => {
    if (released) return;
    released = true;
    await reservationConn.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => {});
    await reservationConn.end().catch(() => {});
  };

  try {
    if (options.enforceTargetScopedGrants !== false && liveDatabaseUrl) {
      const live = parseValidatedMysqlTarget(liveDatabaseUrl);
      if (recovery.host.toLowerCase() === live.host.toLowerCase() && recovery.port === live.port) {
        await assertNoLiveSchemaWritePrivilege(reservationConn, live.database);
      }
    }

    const [lockRows] = await reservationConn.query("SELECT GET_LOCK(?, 0) AS acquired", [lockName]);
    const acquired = Number((lockRows as { acquired: number | null }[])[0]?.acquired ?? 0);
    if (acquired !== 1) {
      throw conflict(
        "TARGET_DATABASE_LOCKED",
        "Target isolated database is currently reserved by another active restore operation.",
      );
    }

    const [schemaRows] = await reservationConn.query(
      "SELECT SCHEMA_NAME AS name FROM information_schema.schemata WHERE LOWER(SCHEMA_NAME) = LOWER(?)",
      [targetDatabaseName],
    );
    const exists = (schemaRows as { name: string }[]).length > 0;
    if (exists) {
      const [tblRows] = await reservationConn.query(
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
      await reservationConn.query(
        `CREATE DATABASE \`${targetDatabaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
      );
    }

    return {
      targetDatabaseUrl: recovery.withDatabase(targetDatabaseName),
      createdDatabase: !exists,
      release,
    };
  } catch (error) {
    await release();
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "UNAVAILABLE",
      "TARGET_DATABASE_PREPARE_FAILED",
      "Failed to reserve or create the isolated target database.",
    );
  }
}

/**
 * Streams a verified gzipped SQL dump into `mysql` (`--defaults-file` first arg, `local-infile=0`, TLS verified)
 * against the isolated target database, re-checking uncompressed SHA-256 on the fly.
 */
export async function loadSqlGzIntoIsolatedDatabase(
  targetDatabaseUrl: string,
  gzChunks: AsyncIterable<Buffer>,
  expected: { uncompressedBytes: number; uncompressedSha256: string },
): Promise<void> {
  const conn = parseValidatedMysqlTarget(targetDatabaseUrl);
  const cnf = await createPrivateDefaultsFile(conn);

  const child = spawn(
    "mysql",
    [
      `--defaults-file=${cnf.filePath}`,
      "--no-login-paths",
      "--protocol=TCP",
      "--no-auto-rehash",
      "--default-character-set=utf8mb4",
      "--binary-mode=1",
      conn.database,
    ],
    {
      shell: false,
      stdio: ["pipe", "ignore", "pipe"],
      env: {
        PATH: "/usr/bin:/bin:/usr/local/bin",
        HOME: cnf.dirPath,
        MYSQL_HOME: cnf.dirPath,
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
