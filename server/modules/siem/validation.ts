import net from "node:net";
import { z } from "zod";
import { AUDIT_CATEGORIES, SEVERITIES } from "../../core/types.js";
import { ULID_PATTERN } from "../../core/ids.js";
import { validation } from "../../core/errors.js";
import { SIEM_FORMATS } from "./types.js";

const HOSTNAME_LABEL = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;

export function normalizeAndValidateHost(rawHost: string): string {
  const trimmed = rawHost.trim().normalize("NFC");
  if (trimmed.length === 0 || trimmed.length > 253) {
    throw validation("INVALID_HOST", "Enter a valid receiver hostname or IP address.");
  }
  if (/[:/?#@\s\\]/.test(trimmed) && net.isIP(trimmed.replace(/^\[|\]$/g, "")) === 0) {
    throw validation("INVALID_HOST", "Enter only the hostname or IP address, without scheme, port, or path.");
  }
  const bare = trimmed.replace(/^\[|\]$/g, "").toLowerCase();
  // Reject integer/hex/octal IPv4 encodings.
  if (/^(?:0x[0-9a-f]+|\d+)$/i.test(bare) || /^(?:0\d+\.)/.test(bare)) {
    throw validation("INVALID_HOST", "Ambiguous numeric IP encodings are not permitted.");
  }
  const ipFamily = net.isIP(bare);
  if (ipFamily === 4 || ipFamily === 6) {
    return bare;
  }
  if (bare.startsWith(".") || bare.endsWith(".") || bare.includes("..")) {
    throw validation("INVALID_HOST", "Enter a valid DNS hostname.");
  }
  const labels = bare.split(".");
  if (labels.some((label) => !HOSTNAME_LABEL.test(label))) {
    throw validation("INVALID_HOST", "Enter a valid DNS hostname.");
  }
  return bare;
}

export function normalizeOtlpPath(rawPath: string | null | undefined, format: string): string | null {
  if (format !== "otlp_https") return null;
  const candidate = (rawPath ?? "/v1/logs").trim();
  if (candidate.length === 0 || candidate.length > 200) {
    throw validation("INVALID_OTLP_PATH", "OTLP path must be between 1 and 200 characters.");
  }
  if (!candidate.startsWith("/") || candidate.startsWith("//") || /[\s?#\\]/.test(candidate) || candidate.includes("..")) {
    throw validation("INVALID_OTLP_PATH", "OTLP path must start with '/' and must not contain query strings or '..'.");
  }
  return candidate;
}

export function normalizeAuthHeaderName(rawName: string | null | undefined, format: string): string | null {
  if (format !== "otlp_https") return null;
  if (rawName === null || rawName === undefined || rawName.trim() === "") return null;
  const trimmed = rawName.trim();
  if (!/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(trimmed)) {
    throw validation("INVALID_AUTH_HEADER", "Authentication header name must contain only ASCII letters, digits, and hyphens.");
  }
  const forbidden = new Set(["host", "content-length", "content-type", "transfer-encoding", "connection", "cookie"]);
  if (forbidden.has(trimmed.toLowerCase())) {
    throw validation("INVALID_AUTH_HEADER", "That HTTP header name cannot be overridden.");
  }
  return trimmed;
}

export const siemSecretsSchema = z.strictObject({
  customCaPem: z.string().max(65_536).nullable().optional(),
  clientCertPem: z.string().max(32_768).nullable().optional(),
  clientKeyPem: z.string().max(32_768).nullable().optional(),
  authSecret: z.string().max(4_096).nullable().optional(),
});

export const createDestinationSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(120, "Name must be 120 characters or fewer.")
    .transform((v) => v.normalize("NFC")),
  enabled: z.boolean().optional(),
  format: z.enum(SIEM_FORMATS),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65_535).optional(),
  otlpPath: z.string().trim().max(200).nullable().optional(),
  allowPrivateNetwork: z.boolean().optional(),
  facility: z.number().int().min(0).max(23).optional(),
  appName: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[!-~]+$/, "Application name must use printable ASCII without spaces.")
    .optional(),
  hostnameOverride: z
    .string()
    .trim()
    .max(255)
    .refine((v) => v === "" || /^[!-~]+$/.test(v), "Hostname override must use printable ASCII without spaces.")
    .nullable()
    .optional(),
  enterpriseNumber: z.number().int().min(1).max(2_147_483_647).nullable().optional(),
  sdIdName: z
    .string()
    .trim()
    .min(1)
    .max(16)
    .regex(/^[!#-[^-~]+$/, "SD-ID name must be printable ASCII excluding '=', ']', '\"', '\\', and '@'.")
    .refine((v) => !v.includes("=") && !v.includes("@") && !v.includes('"'), "Invalid SD-ID name.")
    .optional(),
  includeBom: z.boolean().optional(),
  maxMessageBytes: z.number().int().min(480).max(65_536).optional(),
  connectTimeoutMs: z.number().int().min(1_000).max(30_000).optional(),
  writeTimeoutMs: z.number().int().min(1_000).max(60_000).optional(),
  minSeverity: z.enum(SEVERITIES).optional(),
  categories: z.array(z.enum(AUDIT_CATEGORIES)).min(1, "Select at least one audit category.").max(AUDIT_CATEGORIES.length),
  authHeaderName: z.string().trim().max(64).nullable().optional(),
  secrets: siemSecretsSchema.optional(),
});

export const updateDestinationSchema = z.strictObject({
  publicId: z.string().regex(ULID_PATTERN, "Invalid destination identifier."),
  expectedVersion: z.number().int().min(1).max(1_000_000_000),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .transform((v) => v.normalize("NFC"))
    .optional(),
  enabled: z.boolean().optional(),
  format: z.enum(SIEM_FORMATS).optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  otlpPath: z.string().trim().max(200).nullable().optional(),
  allowPrivateNetwork: z.boolean().optional(),
  facility: z.number().int().min(0).max(23).optional(),
  appName: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[!-~]+$/, "Application name must use printable ASCII without spaces.")
    .optional(),
  hostnameOverride: z
    .string()
    .trim()
    .max(255)
    .refine((v) => v === "" || /^[!-~]+$/.test(v), "Hostname override must use printable ASCII without spaces.")
    .nullable()
    .optional(),
  enterpriseNumber: z.number().int().min(1).max(2_147_483_647).nullable().optional(),
  sdIdName: z
    .string()
    .trim()
    .min(1)
    .max(16)
    .regex(/^[!#-[^-~]+$/)
    .refine((v) => !v.includes("=") && !v.includes("@") && !v.includes('"'))
    .optional(),
  includeBom: z.boolean().optional(),
  maxMessageBytes: z.number().int().min(480).max(65_536).optional(),
  connectTimeoutMs: z.number().int().min(1_000).max(30_000).optional(),
  writeTimeoutMs: z.number().int().min(1_000).max(60_000).optional(),
  minSeverity: z.enum(SEVERITIES).optional(),
  categories: z.array(z.enum(AUDIT_CATEGORIES)).min(1).max(AUDIT_CATEGORIES.length).optional(),
  authHeaderName: z.string().trim().max(64).nullable().optional(),
  secrets: siemSecretsSchema.optional(),
});

export const setEnabledSchema = z.strictObject({
  publicId: z.string().regex(ULID_PATTERN, "Invalid destination identifier."),
  enabled: z.boolean(),
  expectedVersion: z.number().int().min(1).max(1_000_000_000),
});

export const deleteDestinationSchema = z.strictObject({
  publicId: z.string().regex(ULID_PATTERN, "Invalid destination identifier."),
  expectedVersion: z.number().int().min(1).max(1_000_000_000),
});

export const destinationPublicIdSchema = z.strictObject({
  publicId: z.string().regex(ULID_PATTERN, "Invalid destination identifier."),
});

export const listDeadLettersSchema = z.strictObject({
  destinationPublicId: z.string().regex(ULID_PATTERN).optional(),
  cursor: z.string().max(128).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const replayDeadLettersSchema = z
  .strictObject({
    publicIds: z.array(z.string().regex(ULID_PATTERN)).min(1).max(100).optional(),
    destinationPublicId: z.string().regex(ULID_PATTERN).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .refine((v) => (v.publicIds && v.publicIds.length > 0) || Boolean(v.destinationPublicId), {
    message: "Specify dead-letter item IDs or a destination ID to replay.",
  });

export const purgeDeadLettersSchema = z.strictObject({
  publicIds: z.array(z.string().regex(ULID_PATTERN)).min(1).max(100),
});
