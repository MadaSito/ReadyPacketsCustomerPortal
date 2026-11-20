/**
 * Structured JSON logger with redaction and request-context correlation. Owner: audit engineer.
 * Contract: one JSON object per line on stdout/stderr (journald captures it); every line carries
 * service, release, deployment profile, request/trace/span/correlation ids when a request context exists.
 * Redaction happens BEFORE serialization. This initial version is intentionally minimal.
 */
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../core/types.js";
import { getRequestContext } from "../core/requestContext.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
const SENSITIVE_KEY = /pass(word)?|secret|token|cookie|authorization|otp|totp|recovery|credential|private|signature|session(?!Id)/i;

function scrub(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > 512 ? `${value.slice(0, 512)}…[truncated]` : value.replace(/[\r\n\u2028\u2029]/g, " ");
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { errorName: value.name };
  if (depth >= 4) return "[depth-limit]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrub(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>).slice(0, 60)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : scrub(inner, depth + 1);
    }
    return out;
  }
  return undefined;
}

export function createLogger(config: Pick<AppConfig, "logLevel" | "serviceName" | "releaseRef" | "deploymentProfile">, bindings: Record<string, unknown> = {}): Logger {
  const threshold = LEVELS[config.logLevel];
  const write = (level: keyof typeof LEVELS, message: string, context?: Record<string, unknown>) => {
    if (LEVELS[level] < threshold) return;
    const request = getRequestContext();
    const line = {
      ts: new Date().toISOString(),
      level,
      msg: message.replace(/[\r\n\u2028\u2029]/g, " "),
      service: config.serviceName,
      release: config.releaseRef,
      profile: config.deploymentProfile,
      requestId: request?.requestId,
      traceId: request?.traceId,
      spanId: request?.spanId,
      correlationId: request?.correlationId,
      ...(scrub({ ...bindings, ...context }) as Record<string, unknown>),
    };
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${JSON.stringify(line)}\n`);
  };
  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
    child: (extra) => createLogger(config, { ...bindings, ...extra }),
  };
}
