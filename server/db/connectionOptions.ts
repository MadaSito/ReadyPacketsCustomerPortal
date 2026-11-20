import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "mysql2";

/**
 * Builds mysql2 options from a `mysql://` URL WITHOUT handing the URL to the driver.
 *
 * mysql2 merges URL query parameters into its options, so a DSN could silently switch on
 * `multipleStatements`, `debug`, `insecureAuth`, or weaken TLS. Only the components below are honoured:
 *   mysql://user:password@host[:port]/database[?tls=required|off][&tlsCaFile=/absolute/path.pem]
 * Any other query parameter is a configuration error. Messages never include the URL or its parts.
 */
export class DatabaseUrlError extends Error {
  override name = "DatabaseUrlError";
}

const ALLOWED_PARAMS = new Set(["tls", "tlsCaFile"]);

export function connectionOptionsFromUrl(url: string): ConnectionOptions {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DatabaseUrlError("DATABASE_URL is not a valid URL.");
  }
  if (parsed.protocol !== "mysql:") throw new DatabaseUrlError("DATABASE_URL must use the mysql:// scheme.");
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!parsed.hostname || !database || database.includes("/")) {
    throw new DatabaseUrlError("DATABASE_URL must include a host and a single database name.");
  }
  if (parsed.hash) throw new DatabaseUrlError("DATABASE_URL must not contain a fragment.");
  for (const key of parsed.searchParams.keys()) {
    if (!ALLOWED_PARAMS.has(key)) throw new DatabaseUrlError("DATABASE_URL contains an unsupported option; only tls and tlsCaFile are accepted.");
  }
  const tls = parsed.searchParams.get("tls") ?? "off";
  if (tls !== "off" && tls !== "required") throw new DatabaseUrlError("DATABASE_URL tls option must be 'required' or 'off'.");
  const caFile = parsed.searchParams.get("tlsCaFile");
  if (caFile && (tls !== "required" || !caFile.startsWith("/"))) {
    throw new DatabaseUrlError("DATABASE_URL tlsCaFile needs tls=required and an absolute path.");
  }
  const port = parsed.port ? Number(parsed.port) : 3306;
  const options: ConnectionOptions = {
    host: parsed.hostname.replace(/^\[|\]$/g, ""),
    port,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    // Fixed, non-negotiable driver behaviour.
    multipleStatements: false,
    debug: false,
    trace: false,
    insecureAuth: false,
    flags: ["-LOCAL_FILES"],
    timezone: "Z",
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
    charset: "utf8mb4",
    connectTimeout: 10_000,
  };
  if (tls === "required") {
    let ca: string | undefined;
    if (caFile) {
      try {
        ca = readFileSync(caFile, "utf8");
      } catch {
        throw new DatabaseUrlError("The database TLS CA file could not be read.");
      }
    }
    // mysql2 skips server-name verification unless `verifyIdentity` is set, so a certificate issued by a
    // trusted CA for a different host would otherwise be accepted.
    options.ssl = { rejectUnauthorized: true, verifyIdentity: true, minVersion: "TLSv1.2", ...(ca ? { ca } : {}) };
  }
  return options;
}
