/**
 * Cryptographic signing, constant-time signature verification, URL masking, and
 * redacted 64 KiB FieldCrypto envelope helpers for Package I webhooks.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FieldCrypto } from "../../../core/types.js";
import { SENSITIVE_KEY, neutraliseControl, redact, safeString } from "../../../observability/redact.js";

export const MAX_LOGGED_BODY_BYTES = 65_536; // 64 KiB per Decision 11
export const MAX_INBOUND_RAW_BODY_BYTES = 262_144; // 256 KiB per server/http/API.md
export const MAX_TIMESTAMP_SKEW_SECONDS = 300; // ±5 minutes per Contract §4

export interface StoredDeliveryPayloadEnvelope {
  requestHeaders: Record<string, string>;
  requestBody: string;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
}

export interface StoredAttemptResponseEnvelope {
  responseHeaders: Record<string, string>;
  responseBody: string;
}

export function generateWebhookSigningSecret(): { secret: string; last4: string } {
  const hex = randomBytes(24).toString("hex");
  const secret = `whsec_${hex}`;
  return { secret, last4: hex.slice(-4) };
}

export function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function computeDigest(secret: string, timestampSec: number, rawBody: Buffer): Buffer {
  const prefix = Buffer.from(`${timestampSec}.`, "utf8");
  return createHmac("sha256", secret).update(prefix).update(rawBody).digest();
}

/**
 * Produces `t=<unixSec>,v1=<hexHmac>[,v1=<overlapHexHmac>]` over `<unixSec>.<rawBody>`.
 */
export function signWebhookPayload(
  rawBody: Buffer,
  timestampSec: number,
  primarySecret: string,
  overlapSecret?: string | null,
): string {
  const primaryHex = computeDigest(primarySecret, timestampSec, rawBody).toString("hex");
  if (overlapSecret && overlapSecret !== primarySecret) {
    const overlapHex = computeDigest(overlapSecret, timestampSec, rawBody).toString("hex");
    return `t=${timestampSec},v1=${primaryHex},v1=${overlapHex}`;
  }
  return `t=${timestampSec},v1=${primaryHex}`;
}

export type InboundSignatureVerdict =
  | { ok: true; timestampSec: number; matchedKey: "primary" | "overlap" }
  | {
      ok: false;
      reasonCode:
        | "MISSING_SIGNATURE"
        | "MALFORMED_SIGNATURE"
        | "WEBHOOK_TIMESTAMP_EXPIRED"
        | "INVALID_SIGNATURE";
    };

/**
 * Verifies `X-ReadyPackets-Signature: t=<unixSec>,v1=<64-hex>` over raw bytes BEFORE JSON parsing.
 * Enforces `|nowSec - timestampSec| <= toleranceSeconds` (clamped 30..300s) and constant-time
 * `timingSafeEqual` over fixed 32-byte digests across primary and unexpired overlap secrets.
 */
export function verifyInboundWebhookSignature(input: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  now: Date;
  primarySecret: string;
  overlapSecret?: string | null;
  overlapExpiresAt?: Date | null;
  toleranceSeconds?: number;
}): InboundSignatureVerdict {
  const rawSig = input.signatureHeader?.trim();
  if (!rawSig) {
    return { ok: false, reasonCode: "MISSING_SIGNATURE" };
  }
  if (rawSig.length > 1024) {
    return { ok: false, reasonCode: "MALFORMED_SIGNATURE" };
  }

  let timestampSec: number | null = null;
  const candidateDigests: Buffer[] = [];
  for (const rawPart of rawSig.split(",")) {
    const eqIdx = rawPart.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = rawPart.slice(0, eqIdx).trim();
    const val = rawPart.slice(eqIdx + 1).trim();
    if (key === "t" && timestampSec === null) {
      if (!/^\d{9,12}$/.test(val)) {
        return { ok: false, reasonCode: "MALFORMED_SIGNATURE" };
      }
      const parsed = Number.parseInt(val, 10);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        return { ok: false, reasonCode: "MALFORMED_SIGNATURE" };
      }
      timestampSec = parsed;
    } else if (key === "v1") {
      if (/^[0-9a-fA-F]{64}$/.test(val) && candidateDigests.length < 8) {
        candidateDigests.push(Buffer.from(val, "hex"));
      }
    }
  }

  if (timestampSec === null || candidateDigests.length === 0) {
    return { ok: false, reasonCode: "MALFORMED_SIGNATURE" };
  }

  const maxSkew = Math.min(
    MAX_TIMESTAMP_SKEW_SECONDS,
    Math.max(30, Math.trunc(input.toleranceSeconds ?? MAX_TIMESTAMP_SKEW_SECONDS)),
  );
  const nowSec = Math.floor(input.now.getTime() / 1000);
  if (Math.abs(nowSec - timestampSec) > maxSkew) {
    return { ok: false, reasonCode: "WEBHOOK_TIMESTAMP_EXPIRED" };
  }

  const expectedPrimary = computeDigest(input.primarySecret, timestampSec, input.rawBody);
  const overlapActive =
    Boolean(input.overlapSecret) &&
    input.overlapExpiresAt instanceof Date &&
    input.now.getTime() < input.overlapExpiresAt.getTime();
  const expectedOverlap = overlapActive
    ? computeDigest(input.overlapSecret!, timestampSec, input.rawBody)
    : null;

  let primaryMatched = false;
  let overlapMatched = false;
  for (const candidate of candidateDigests) {
    if (candidate.byteLength === expectedPrimary.byteLength && timingSafeEqual(expectedPrimary, candidate)) {
      primaryMatched = true;
    }
    if (
      expectedOverlap &&
      candidate.byteLength === expectedOverlap.byteLength &&
      timingSafeEqual(expectedOverlap, candidate)
    ) {
      overlapMatched = true;
    }
  }

  if (primaryMatched) {
    return { ok: true, timestampSec, matchedKey: "primary" };
  }
  if (overlapMatched) {
    return { ok: true, timestampSec, matchedKey: "overlap" };
  }
  return { ok: false, reasonCode: "INVALID_SIGNATURE" };
}

/**
 * Masks a validated HTTPS webhook destination URL so query parameters and long path tokens
 * never appear in console listings or logs.
 */
export function maskWebhookTargetUrl(rawUrl: string): { host: string; maskedUrl: string; maskedPath: string } {
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .slice(0, 8)
    .map((seg) => {
      if (seg.length > 24 || /[A-Za-z0-9_-]{20,}/.test(seg)) {
        return `${seg.slice(0, 4)}…${seg.slice(-3)}`;
      }
      return seg.replace(/[^A-Za-z0-9._~-]/g, "_");
    });
  const pathPart = segments.length > 0 ? `/${segments.join("/")}` : "/";
  const querySuffix = parsed.search ? "?[redacted]" : "";
  const maskedPath = `${pathPart}${querySuffix}`.slice(0, 250);
  const maskedUrl = `https://${host}${maskedPath}`.slice(0, 320);
  return { host, maskedUrl, maskedPath };
}

export function redactHeaderMap(headers: Record<string, string | undefined> | null | undefined): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  const keys = Object.keys(headers).slice(0, 50);
  for (const rawKey of keys) {
    const val = headers[rawKey];
    if (val === undefined) continue;
    const cleanKey = neutraliseControl(rawKey.toLowerCase()).slice(0, 64);
    if (SENSITIVE_KEY.test(cleanKey) || cleanKey.includes("hmac") || cleanKey.includes("sig")) {
      out[cleanKey] = "[redacted]";
    } else {
      out[cleanKey] = safeString(val, { maxString: 512 });
    }
  }
  return out;
}

function boundUtf8String(input: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(input, "utf8") <= maxBytes) {
    return { value: input, truncated: false };
  }
  // Binary search char slice so we never split a surrogate pair or exceed `maxBytes` UTF-8 bytes.
  let lo = 0;
  let hi = Math.min(input.length, maxBytes);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(input.slice(0, mid), "utf8") <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  let sliced = input.slice(0, lo);
  // Avoid trailing lone high surrogate.
  if (sliced.length > 0) {
    const lastCode = sliced.charCodeAt(sliced.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      sliced = sliced.slice(0, -1);
    }
  }
  return { value: sliced, truncated: true };
}

/**
 * Redacts a JSON or plain-text body using `server/observability/redact.ts` and bounds it strictly
 * to `MAX_LOGGED_BODY_BYTES` (64 KiB). Marks `truncated = true` whenever the input exceeded 64 KiB
 * or structural limits truncated keys/arrays.
 */
export function redactAndBoundBody(rawBody: Buffer | string): { body: string; truncated: boolean } {
  const rawBuffer = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const inputExceeded = rawBuffer.byteLength > MAX_LOGGED_BODY_BYTES;
  const boundedInput = inputExceeded
    ? boundUtf8String(rawBuffer.toString("utf8", 0, MAX_LOGGED_BODY_BYTES + 16), MAX_LOGGED_BODY_BYTES).value
    : rawBuffer.toString("utf8");

  if (!inputExceeded) {
    try {
      const parsed = JSON.parse(boundedInput) as unknown;
      const redactedObj = redact(parsed, {
        maxDepth: 7,
        maxKeys: 120,
        maxArray: 120,
        maxString: 8192,
      });
      const jsonText = JSON.stringify(redactedObj);
      const structTruncated =
        jsonText.includes('"_truncated_keys":') ||
        jsonText.includes(' items]"') ||
        jsonText.includes('"[depth-limit]"') ||
        jsonText.includes("…[truncated ");
      const boundedJson = boundUtf8String(jsonText, MAX_LOGGED_BODY_BYTES);
      return {
        body: boundedJson.value,
        truncated: structTruncated || boundedJson.truncated,
      };
    } catch {
      // Fall through to plain-text redaction.
    }
  }

  const scanned = safeString(boundedInput, { maxString: MAX_LOGGED_BODY_BYTES });
  const boundedText = boundUtf8String(scanned, MAX_LOGGED_BODY_BYTES);
  return {
    body: boundedText.value,
    truncated: inputExceeded || boundedText.truncated || scanned.includes("…[truncated "),
  };
}

export function deliveryPayloadAad(deliveryPublicId: string): string {
  return `integration_webhook_deliveries:payload:${deliveryPublicId}`;
}

export function deliveryTapEventAad(deliveryPublicId: string): string {
  return `integration_webhook_deliveries:tap_event:${deliveryPublicId}`;
}

export function attemptResponseAad(attemptPublicId: string): string {
  return `integration_webhook_delivery_attempts:response:${attemptPublicId}`;
}

export function subscriptionUrlAad(subscriptionPublicId: string): string {
  return `integration_webhook_subscriptions:target_url:${subscriptionPublicId}`;
}

export function subscriptionSecretAad(subscriptionPublicId: string): string {
  return `integration_webhook_subscriptions:signing_secret:${subscriptionPublicId}`;
}

export function inboundSecretAad(endpointPublicId: string): string {
  return `integration_webhook_inbound_endpoints:signing_secret:${endpointPublicId}`;
}

export function encryptDeliveryPayload(
  crypto: FieldCrypto,
  deliveryPublicId: string,
  envelope: StoredDeliveryPayloadEnvelope,
): string {
  return crypto.encrypt(JSON.stringify(envelope), deliveryPayloadAad(deliveryPublicId));
}

export function decryptDeliveryPayload(
  crypto: FieldCrypto,
  deliveryPublicId: string,
  ciphertext: string | null,
): StoredDeliveryPayloadEnvelope | null {
  if (!ciphertext) return null;
  const plain = crypto.decrypt(ciphertext, deliveryPayloadAad(deliveryPublicId));
  return JSON.parse(plain) as StoredDeliveryPayloadEnvelope;
}

export function encryptAttemptResponse(
  crypto: FieldCrypto,
  attemptPublicId: string,
  envelope: StoredAttemptResponseEnvelope,
): string {
  return crypto.encrypt(JSON.stringify(envelope), attemptResponseAad(attemptPublicId));
}

export function decryptAttemptResponse(
  crypto: FieldCrypto,
  attemptPublicId: string,
  ciphertext: string | null,
): StoredAttemptResponseEnvelope | null {
  if (!ciphertext) return null;
  const plain = crypto.decrypt(ciphertext, attemptResponseAad(attemptPublicId));
  return JSON.parse(plain) as StoredAttemptResponseEnvelope;
}
