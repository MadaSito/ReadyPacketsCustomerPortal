/**
 * Structured JSON logger with redaction and request-context correlation. Owner: audit engineer.
 *
 * One JSON object per line (journald / container log drivers capture it). Field names follow the
 * OpenTelemetry Logs Data Model where one exists (snake_case flattening):
 *   timestamp, observed_timestamp, severity_text, severity_number, body,
 *   trace_id, span_id, trace_flags-free; resource: service_name, service_version, deployment_profile;
 *   attributes: request_id, correlation_id, parent_correlation_id, origin, plus redacted context.
 *
 * Guarantees:
 *  - Redaction happens BEFORE serialisation (key- and value-based, see redact.ts).
 *  - CR/LF/control characters are neutralised in every string (no log forging).
 *  - Each line is bounded (MAX_LINE_BYTES); oversized context is replaced, never split.
 *  - Errors serialise as name + safe codes. Message and stack ONLY when logLevel=debug outside production.
 *  - The logger never throws to its caller.
 */
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../core/types.js";
import { getRequestContext } from "../core/requestContext.js";
import { neutraliseControl, redact, truncate, type RedactOptions } from "./redact.js";

export const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LOG_LEVELS;

/** OpenTelemetry severity numbers (first value of each range). */
export const OTEL_SEVERITY_NUMBER = { TRACE: 1, DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17, FATAL: 21 } as const;
const LEVEL_TO_OTEL = { debug: "DEBUG", info: "INFO", warn: "WARN", error: "ERROR" } as const;

export const MAX_LINE_BYTES = 16 * 1024;
const RESERVED = new Set([
  "timestamp",
  "observed_timestamp",
  "severity_text",
  "severity_number",
  "level",
  "body",
  "service_name",
  "service_version",
  "deployment_profile",
  "request_id",
  "trace_id",
  "span_id",
  "correlation_id",
  "parent_correlation_id",
  "origin",
]);

export type LoggerConfig = Pick<AppConfig, "logLevel" | "serviceName" | "releaseRef" | "deploymentProfile">;

export interface LogSink {
  write(level: LogLevel, line: string): void;
}

const stdSink: LogSink = {
  write(level, line) {
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
  },
};

let activeSink: LogSink = stdSink;
/** Test hook: capture log lines. Returns a restore function. */
export function setLogSink(sink: LogSink): () => void {
  const previous = activeSink;
  activeSink = sink;
  return () => {
    activeSink = previous;
  };
}

export function buildLogLine(
  config: LoggerConfig,
  level: LogLevel,
  message: string,
  bindings: Record<string, unknown>,
  context: Record<string, unknown> | undefined,
  now: Date = new Date(),
): string {
  const options: RedactOptions = {
    includeStacks: config.logLevel === "debug" && config.deploymentProfile !== "production",
  };
  const request = getRequestContext();
  const severity = LEVEL_TO_OTEL[level];
  const redacted = redact({ ...bindings, ...(context ?? {}) }, options) as Record<string, unknown>;
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(redacted)) {
    attributes[RESERVED.has(key) ? `ctx_${key}` : key] = value;
  }
  const line: Record<string, unknown> = {
    timestamp: now.toISOString(),
    severity_text: severity,
    severity_number: OTEL_SEVERITY_NUMBER[severity],
    level,
    body: truncate(neutraliseControl(String(redact(message, options))), 512),
    service_name: config.serviceName,
    service_version: config.releaseRef,
    deployment_profile: config.deploymentProfile,
  };
  if (request) {
    line.request_id = request.requestId;
    line.trace_id = request.traceId;
    line.span_id = request.spanId;
    if (request.correlationId) line.correlation_id = request.correlationId;
    if (request.parentCorrelationId) line.parent_correlation_id = request.parentCorrelationId;
    line.origin = request.origin;
    if (request.actor) {
      line.actor_role = request.actor.role;
    }
  }
  let serialised = JSON.stringify({ ...line, ...attributes });
  if (Buffer.byteLength(serialised, "utf8") > MAX_LINE_BYTES) {
    serialised = JSON.stringify({ ...line, attributes_truncated: true, attribute_keys: Object.keys(attributes).slice(0, 40) });
  }
  return serialised;
}

export function createLogger(config: LoggerConfig, bindings: Record<string, unknown> = {}): Logger {
  const threshold = LOG_LEVELS[config.logLevel];
  const write = (level: LogLevel, message: string, context?: Record<string, unknown>) => {
    if (LOG_LEVELS[level] < threshold) return;
    try {
      activeSink.write(level, buildLogLine(config, level, message, bindings, context));
    } catch {
      // A logger must never take the request down. Emit a minimal fixed line instead.
      try {
        activeSink.write("error", JSON.stringify({ timestamp: new Date().toISOString(), severity_text: "ERROR", severity_number: 17, body: "log serialisation failed" }));
      } catch {
        /* nothing else we can safely do */
      }
    }
  };
  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
    child: (extra) => createLogger(config, { ...bindings, ...extra }),
  };
}
