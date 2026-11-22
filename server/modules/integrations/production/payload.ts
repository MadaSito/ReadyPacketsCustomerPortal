/**
 * Production Webhooks (P101 Phase I & P201 Phase II) — Pure Payload Builder, Validator & Masking.
 *
 * Implements the authoritative rules from:
 *  - `docs/engineering/INCREMENT_02_CONTRACT.md` (§D, ADR 0023)
 *  - `docs/source-specs/increment-02/P101_PRODUCTION_WEBHOOK_LOGIC_CORRECTED.txt` (wins on conflicts: `order_scope_mode` is NEVER sent)
 *  - `docs/source-specs/increment-02/WEBHOOK_TRIGGER_REFERENCE_P101_P201.txt` (P201 exact identity reuse, escaped JSON string manifest)
 *
 * Pure module: zero database, network, or mutable state dependencies.
 */
import type { UserRole } from "../../../../shared/domain.js";

export const PACKET_TIERS = ["Basic", "Standard", "Premium"] as const;
export type PacketTier = (typeof PACKET_TIERS)[number];

export const TOP_LEVEL_TIERS = ["Basic", "Standard", "Premium", "Mixed"] as const;
export type TopLevelTier = (typeof TOP_LEVEL_TIERS)[number];

export const RUN_MODE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const RELEASE_STATUS_PATTERN = /^[A-Za-z0-9_.-]{0,120}$/;
export const CANON_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

const PACKET_TIER_SET: ReadonlySet<string> = new Set(PACKET_TIERS);
const VALID_SINGLE_PACKET_STRINGS: ReadonlySet<string> = new Set(["1", "2", "3", "4", "5", "6"]);
const MANIFEST_KEY_PATTERN = /^packet_([1-9][0-9]*)$/;

const P101_EXACT_KEYS = [
  "customer_id",
  "order_id",
  "packet",
  "tier",
  "canon_version",
  "run_mode",
  "client_name",
  "client_email",
  "release_status",
  "bundle_scope_manifest",
] as const;
const P101_KEY_SET: ReadonlySet<string> = new Set(P101_EXACT_KEYS);

const P201_EXACT_KEYS = ["customer_id", "order_id", "run_mode"] as const;
const P201_KEY_SET: ReadonlySet<string> = new Set(P201_EXACT_KEYS);

export interface P101Payload {
  customer_id: string;
  order_id: string;
  packet: string;
  tier: string;
  canon_version: string;
  run_mode: string;
  client_name: string;
  client_email: string;
  release_status: string;
  bundle_scope_manifest: string;
}

export interface P201Payload {
  customer_id: string;
  order_id: string;
  run_mode: string;
}

export type P301Payload = P201Payload;
export type P401Payload = P201Payload;

export interface ProductionIdentityTriple {
  customerId: string;
  orderId: string;
  runMode: string;
}

export interface OrderPacketSelection {
  packetNumber: number;
  tier: PacketTier;
}

export interface PayloadValidationIssue {
  code: string;
  message: string;
}

export type PayloadValidationResult<T> =
  | { ok: true; payload: T; errors: [] }
  | { ok: false; payload: null; errors: PayloadValidationIssue[] };

export interface BuildP101Input {
  customerRef: string | null | undefined;
  orderReference: string;
  canonVersion: string;
  runMode: string;
  clientName: string;
  clientEmail: string;
  releaseStatus?: string;
  packets: readonly OrderPacketSelection[];
  otherItemCount: number;
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validates a candidate P101 payload against every invariant in `P101_PRODUCTION_WEBHOOK_LOGIC_CORRECTED.txt`
 * and `WEBHOOK_TRIGGER_REFERENCE_P101_P201.txt` before queueing or sending.
 */
export function validateP101(candidate: unknown): PayloadValidationResult<P101Payload> {
  const errors: PayloadValidationIssue[] = [];

  if (!isPlainRecord(candidate)) {
    return {
      ok: false,
      payload: null,
      errors: [{ code: "P101_NOT_OBJECT", message: "P101 payload must be a JSON object." }],
    };
  }

  // 1. Explicitly forbid `order_scope_mode` (corrected P101 spec wins: P5_MASTER_STATE has no such column)
  if ("order_scope_mode" in candidate) {
    errors.push({
      code: "P101_ORDER_SCOPE_MODE_FORBIDDEN",
      message: "order_scope_mode must never be included in P101 payloads.",
    });
  }

  // 2. Enforce exact key set & string-only values (e.g. `packet` must be string `"7"`, never number `7`;
  //    `bundle_scope_manifest` must be an escaped JSON string, never a raw nested object)
  for (const key of Object.keys(candidate)) {
    if (key !== "order_scope_mode" && !P101_KEY_SET.has(key)) {
      errors.push({
        code: "P101_UNEXPECTED_FIELD",
        message: `Unexpected P101 field: ${key}.`,
      });
    }
  }

  for (const requiredKey of P101_EXACT_KEYS) {
    const val = candidate[requiredKey];
    if (typeof val !== "string") {
      errors.push({
        code: `P101_${requiredKey.toUpperCase()}_NOT_STRING`,
        message: `${requiredKey} must be a string value.`,
      });
    } else if (hasControlChars(val)) {
      errors.push({
        code: `P101_${requiredKey.toUpperCase()}_CONTROL_CHARS`,
        message: `${requiredKey} must not contain control characters.`,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, payload: null, errors };
  }

  const raw = candidate as unknown as P101Payload;

  // 3. Identity & metadata field checks
  if (raw.customer_id.trim().length === 0 || raw.customer_id.length > 120) {
    errors.push({
      code: "P101_CUSTOMER_ID_INVALID",
      message: "customer_id must be a non-empty customer reference.",
    });
  }
  if (raw.order_id.trim().length === 0 || raw.order_id.length > 120) {
    errors.push({
      code: "P101_ORDER_ID_INVALID",
      message: "order_id must be a non-empty order reference.",
    });
  }
  if (!CANON_VERSION_PATTERN.test(raw.canon_version)) {
    errors.push({
      code: "P101_CANON_VERSION_INVALID",
      message: "canon_version is required and may contain only letters, digits, underscores, dots, and hyphens.",
    });
  }
  if (!RUN_MODE_PATTERN.test(raw.run_mode)) {
    errors.push({
      code: "P101_RUN_MODE_INVALID",
      message: "run_mode must match ^[a-z][a-z0-9_]{0,31}$.",
    });
  }
  if (raw.client_name.trim().length === 0 || raw.client_name.length > 200) {
    errors.push({
      code: "P101_CLIENT_NAME_INVALID",
      message: "client_name must be a non-empty client display name.",
    });
  }
  if (
    raw.client_email.trim().length === 0 ||
    raw.client_email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.client_email)
  ) {
    errors.push({
      code: "P101_CLIENT_EMAIL_INVALID",
      message: "client_email must be a valid email address.",
    });
  }
  if (!RELEASE_STATUS_PATTERN.test(raw.release_status)) {
    errors.push({
      code: "P101_RELEASE_STATUS_INVALID",
      message: "release_status must match ^[A-Za-z0-9_.-]{0,120}$.",
    });
  }

  // 4. Top-level packet & tier mutual consistency checks
  const isPacket7 = raw.packet === "7";
  const isValidSinglePacket = VALID_SINGLE_PACKET_STRINGS.has(raw.packet);
  if (!isPacket7 && !isValidSinglePacket) {
    errors.push({
      code: "P101_PACKET_INVALID",
      message: "packet must be \"1\"..\"6\" for a single-packet order or \"7\" for a multi-packet order.",
    });
  }

  const isMixedTier = raw.tier === "Mixed";
  const isNormalTier = PACKET_TIER_SET.has(raw.tier);
  if (!isMixedTier && !isNormalTier) {
    errors.push({
      code: "P101_TIER_UNKNOWN",
      message: "tier must be Basic, Standard, Premium, or Mixed.",
    });
  }

  if (isPacket7 && !isMixedTier) {
    errors.push({
      code: "P101_PACKET_7_REQUIRES_MIXED",
      message: "Packet 7 must pair with tier \"Mixed\" only.",
    });
  }
  if (isMixedTier && !isPacket7) {
    errors.push({
      code: "P101_MIXED_REQUIRES_PACKET_7",
      message: "Tier \"Mixed\" is reserved for multi-packet Packet 7 orders only.",
    });
  }

  // 5. Parse & validate `bundle_scope_manifest` JSON string
  if (raw.bundle_scope_manifest.trim().length === 0) {
    errors.push({
      code: "P101_MANIFEST_MISSING",
      message: "bundle_scope_manifest must be a non-empty JSON string.",
    });
    return { ok: false, payload: null, errors };
  }

  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(raw.bundle_scope_manifest);
  } catch {
    errors.push({
      code: "P101_MANIFEST_INVALID_JSON",
      message: "bundle_scope_manifest must be a valid JSON string.",
    });
    return { ok: false, payload: null, errors };
  }

  if (!isPlainRecord(parsedManifest)) {
    errors.push({
      code: "P101_MANIFEST_NOT_OBJECT",
      message: "bundle_scope_manifest JSON string must decode to an object mapping packet_<n> to tier.",
    });
    return { ok: false, payload: null, errors };
  }

  if ("order_scope_mode" in parsedManifest) {
    errors.push({
      code: "P101_ORDER_SCOPE_MODE_FORBIDDEN",
      message: "order_scope_mode must not appear inside bundle_scope_manifest.",
    });
  }

  const manifestKeys = Object.keys(parsedManifest);
  if (manifestKeys.length === 0) {
    errors.push({
      code: "P101_MANIFEST_EMPTY",
      message: "bundle_scope_manifest must contain at least one packet_<n> entry.",
    });
    return { ok: false, payload: null, errors };
  }

  const manifestPacketNumbers: number[] = [];
  for (const key of manifestKeys) {
    if (key === "order_scope_mode") continue;
    const match = MANIFEST_KEY_PATTERN.exec(key);
    if (!match) {
      errors.push({
        code: "P101_MANIFEST_KEY_INVALID",
        message: `Invalid manifest key "${key}"; expected packet_1 through packet_6.`,
      });
      continue;
    }
    const num = Number(match[1]);
    if (!Number.isInteger(num) || num < 1 || num > 6) {
      errors.push({
        code: "P101_MANIFEST_PACKET_OUT_OF_RANGE",
        message: `Manifest packet number ${num} is outside the valid 1–6 range.`,
      });
      continue;
    }
    manifestPacketNumbers.push(num);

    const tierVal = parsedManifest[key];
    if (typeof tierVal !== "string" || !PACKET_TIER_SET.has(tierVal)) {
      errors.push({
        code: "P101_MANIFEST_TIER_UNKNOWN",
        message: `Manifest entry ${key} must have tier Basic, Standard, or Premium.`,
      });
    }
  }

  // Enforce ascending `packet_<n>` key order
  for (let i = 1; i < manifestPacketNumbers.length; i += 1) {
    if (manifestPacketNumbers[i]! <= manifestPacketNumbers[i - 1]!) {
      errors.push({
        code: "P101_MANIFEST_KEYS_NOT_ASCENDING",
        message: "bundle_scope_manifest keys must appear in strictly ascending packet_<n> order.",
      });
      break;
    }
  }

  // 6. Cross-check top-level `packet` + `tier` against `bundle_scope_manifest`
  if (isPacket7 && isMixedTier) {
    if (manifestKeys.length < 2) {
      errors.push({
        code: "P101_PACKET_7_SINGLE_MANIFEST_CONTRADICTION",
        message: "Packet 7 / Mixed requires two or more packets in bundle_scope_manifest.",
      });
    }
  } else if (isValidSinglePacket && isNormalTier) {
    const expectedKey = `packet_${raw.packet}`;
    if (manifestKeys.length !== 1 || manifestKeys[0] !== expectedKey || parsedManifest[expectedKey] !== raw.tier) {
      errors.push({
        code: "P101_SINGLE_PACKET_MANIFEST_MISMATCH",
        message: `Single-packet P101 (${expectedKey}: ${raw.tier}) must match bundle_scope_manifest exactly.`,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, payload: null, errors };
  }

  return { ok: true, payload: raw, errors: [] };
}

/**
 * Builds and validates a canonical P101 payload from an order's packet scope and owner metadata.
 * Refuses orders with zero packet items, any non-packet item, duplicate packets, or packets outside 1–6.
 */
export function buildP101Payload(input: BuildP101Input): PayloadValidationResult<P101Payload> {
  const errors: PayloadValidationIssue[] = [];

  if (input.otherItemCount > 0) {
    errors.push({
      code: "ORDER_HAS_NON_PACKET_ITEMS",
      message: "Orders containing non-packet catalog items cannot be sent to the production pipeline.",
    });
  }
  if (input.packets.length === 0) {
    errors.push({
      code: "ORDER_HAS_NO_PACKETS",
      message: "Orders without packet line items (1–6) cannot be sent to the production pipeline.",
    });
  }

  const seenPackets = new Set<number>();
  for (const item of input.packets) {
    if (!Number.isInteger(item.packetNumber) || item.packetNumber < 1 || item.packetNumber > 6) {
      errors.push({
        code: "ORDER_PACKET_OUT_OF_RANGE",
        message: `Packet ${item.packetNumber} is outside the supported 1–6 range.`,
      });
    } else if (seenPackets.has(item.packetNumber)) {
      errors.push({
        code: "ORDER_DUPLICATE_PACKET",
        message: `Order contains multiple line items for packet ${item.packetNumber}.`,
      });
    } else {
      seenPackets.add(item.packetNumber);
    }

    if (!PACKET_TIER_SET.has(item.tier)) {
      errors.push({
        code: "ORDER_PACKET_TIER_INVALID",
        message: `Unsupported packet tier: ${String(item.tier)}.`,
      });
    }
  }

  const customerId = (input.customerRef ?? "").trim();
  if (!customerId) {
    errors.push({
      code: "CUSTOMER_REF_MISSING",
      message: "Order owner does not have an assigned customer reference (customer_id).",
    });
  }

  if (!input.canonVersion.trim()) {
    errors.push({
      code: "CANON_VERSION_REQUIRED",
      message: "Production canon_version must be configured before building P101.",
    });
  }

  if (errors.length > 0) {
    return { ok: false, payload: null, errors };
  }

  const sortedPackets = [...input.packets].sort((a, b) => a.packetNumber - b.packetNumber);
  const manifestObj: Record<string, PacketTier> = {};
  for (const p of sortedPackets) {
    manifestObj[`packet_${p.packetNumber}`] = p.tier;
  }

  const isMulti = sortedPackets.length > 1;
  const candidate: P101Payload = {
    customer_id: customerId,
    order_id: input.orderReference.trim(),
    packet: isMulti ? "7" : String(sortedPackets[0]!.packetNumber),
    tier: isMulti ? "Mixed" : sortedPackets[0]!.tier,
    canon_version: input.canonVersion.trim(),
    run_mode: input.runMode.trim(),
    client_name: input.clientName.trim(),
    client_email: input.clientEmail.trim(),
    release_status: (input.releaseStatus ?? "").trim(),
    bundle_scope_manifest: JSON.stringify(manifestObj),
  };

  return validateP101(candidate);
}

/**
 * Validates a P201 Phase II payload and (when provided) enforces exact identity-triple parity with the
 * delivered P101 record for the same order.
 */
export function validateP201(
  candidate: unknown,
  expectedFromDeliveredP101?: ProductionIdentityTriple,
): PayloadValidationResult<P201Payload> {
  const errors: PayloadValidationIssue[] = [];

  if (!isPlainRecord(candidate)) {
    return {
      ok: false,
      payload: null,
      errors: [{ code: "P201_NOT_OBJECT", message: "P201 payload must be a JSON object." }],
    };
  }

  if ("order_scope_mode" in candidate) {
    errors.push({
      code: "P201_ORDER_SCOPE_MODE_FORBIDDEN",
      message: "order_scope_mode must never be included in P201 payloads.",
    });
  }

  for (const key of Object.keys(candidate)) {
    if (key !== "order_scope_mode" && !P201_KEY_SET.has(key)) {
      errors.push({
        code: "P201_UNEXPECTED_FIELD",
        message: `Unexpected P201 field: ${key}.`,
      });
    }
  }

  for (const requiredKey of P201_EXACT_KEYS) {
    const val = candidate[requiredKey];
    if (typeof val !== "string") {
      errors.push({
        code: `P201_${requiredKey.toUpperCase()}_NOT_STRING`,
        message: `${requiredKey} must be a string value.`,
      });
    } else if (hasControlChars(val)) {
      errors.push({
        code: `P201_${requiredKey.toUpperCase()}_CONTROL_CHARS`,
        message: `${requiredKey} must not contain control characters.`,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, payload: null, errors };
  }

  const raw = candidate as unknown as P201Payload;

  if (raw.customer_id.trim().length === 0 || raw.customer_id.length > 120) {
    errors.push({
      code: "P201_CUSTOMER_ID_INVALID",
      message: "customer_id must be a non-empty customer reference.",
    });
  }
  if (raw.order_id.trim().length === 0 || raw.order_id.length > 120) {
    errors.push({
      code: "P201_ORDER_ID_INVALID",
      message: "order_id must be a non-empty order reference.",
    });
  }
  if (!RUN_MODE_PATTERN.test(raw.run_mode)) {
    errors.push({
      code: "P201_RUN_MODE_INVALID",
      message: "run_mode must match ^[a-z][a-z0-9_]{0,31}$.",
    });
  }

  if (expectedFromDeliveredP101) {
    if (raw.customer_id !== expectedFromDeliveredP101.customerId) {
      errors.push({
        code: "P201_CUSTOMER_ID_MISMATCH",
        message: "P201 customer_id must match the delivered P101 customer_id verbatim.",
      });
    }
    if (raw.order_id !== expectedFromDeliveredP101.orderId) {
      errors.push({
        code: "P201_ORDER_ID_MISMATCH",
        message: "P201 order_id must match the delivered P101 order_id verbatim.",
      });
    }
    if (raw.run_mode !== expectedFromDeliveredP101.runMode) {
      errors.push({
        code: "P201_RUN_MODE_MISMATCH",
        message: "P201 run_mode must match the delivered P101 run_mode verbatim.",
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, payload: null, errors };
  }

  return { ok: true, payload: raw, errors: [] };
}

export type LaterProductionPhase = "P201" | "P301" | "P401";

/**
 * Validates a Phase II/III/IV (`P201` | `P301` | `P401`) `{ customer_id, order_id, run_mode }` payload
 * and (when provided) enforces exact identity-triple parity with the delivered P101 record for the order.
 * Delegates `P201` directly to `validateP201` so existing `P201_*` error codes remain byte-identical.
 */
export function validateLaterPhasePayload(
  phase: LaterProductionPhase,
  candidate: unknown,
  expectedFromDeliveredP101?: ProductionIdentityTriple,
): PayloadValidationResult<P201Payload> {
  if (phase === "P201") {
    return validateP201(candidate, expectedFromDeliveredP101);
  }

  const errors: PayloadValidationIssue[] = [];

  if (!isPlainRecord(candidate)) {
    return {
      ok: false,
      payload: null,
      errors: [{ code: `${phase}_NOT_OBJECT`, message: `${phase} payload must be a JSON object.` }],
    };
  }

  if ("order_scope_mode" in candidate) {
    errors.push({
      code: `${phase}_ORDER_SCOPE_MODE_FORBIDDEN`,
      message: `order_scope_mode must never be included in ${phase} payloads.`,
    });
  }

  for (const key of Object.keys(candidate)) {
    if (key !== "order_scope_mode" && !P201_KEY_SET.has(key)) {
      errors.push({
        code: `${phase}_UNEXPECTED_FIELD`,
        message: `Unexpected ${phase} field: ${key}.`,
      });
    }
  }

  for (const requiredKey of P201_EXACT_KEYS) {
    const val = candidate[requiredKey];
    if (typeof val !== "string") {
      errors.push({
        code: `${phase}_${requiredKey.toUpperCase()}_NOT_STRING`,
        message: `${requiredKey} must be a string value.`,
      });
    } else if (hasControlChars(val)) {
      errors.push({
        code: `${phase}_${requiredKey.toUpperCase()}_CONTROL_CHARS`,
        message: `${requiredKey} must not contain control characters.`,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, payload: null, errors };
  }

  const raw = candidate as unknown as P201Payload;

  if (raw.customer_id.trim().length === 0 || raw.customer_id.length > 120) {
    errors.push({
      code: `${phase}_CUSTOMER_ID_INVALID`,
      message: "customer_id must be a non-empty customer reference.",
    });
  }
  if (raw.order_id.trim().length === 0 || raw.order_id.length > 120) {
    errors.push({
      code: `${phase}_ORDER_ID_INVALID`,
      message: "order_id must be a non-empty order reference.",
    });
  }
  if (!RUN_MODE_PATTERN.test(raw.run_mode)) {
    errors.push({
      code: `${phase}_RUN_MODE_INVALID`,
      message: "run_mode must match ^[a-z][a-z0-9_]{0,31}$.",
    });
  }

  if (expectedFromDeliveredP101) {
    if (raw.customer_id !== expectedFromDeliveredP101.customerId) {
      errors.push({
        code: `${phase}_CUSTOMER_ID_MISMATCH`,
        message: `${phase} customer_id must match the delivered P101 customer_id verbatim.`,
      });
    }
    if (raw.order_id !== expectedFromDeliveredP101.orderId) {
      errors.push({
        code: `${phase}_ORDER_ID_MISMATCH`,
        message: `${phase} order_id must match the delivered P101 order_id verbatim.`,
      });
    }
    if (raw.run_mode !== expectedFromDeliveredP101.runMode) {
      errors.push({
        code: `${phase}_RUN_MODE_MISMATCH`,
        message: `${phase} run_mode must match the delivered P101 run_mode verbatim.`,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, payload: null, errors };
  }

  return { ok: true, payload: raw, errors: [] };
}

/**
 * Constructs a later-phase (`P201` | `P301` | `P401`) `{ customer_id, order_id, run_mode }` payload
 * solely from the stored, delivered P101 identity triple (never recomputed from mutable customer/order rows).
 */
export function buildLaterPhaseFromDeliveredP101(
  phase: LaterProductionPhase,
  deliveredP101: ProductionIdentityTriple,
): PayloadValidationResult<P201Payload> {
  const candidate: P201Payload = {
    customer_id: deliveredP101.customerId,
    order_id: deliveredP101.orderId,
    run_mode: deliveredP101.runMode,
  };
  return validateLaterPhasePayload(phase, candidate, deliveredP101);
}

/**
 * Constructs a P201 payload solely from the stored, delivered P101 identity triple (never recomputed
 * from mutable customer/order tables so later reference edits cannot break an active production run).
 */
export function buildP201FromDeliveredP101(deliveredP101: ProductionIdentityTriple): PayloadValidationResult<P201Payload> {
  const candidate: P201Payload = {
    customer_id: deliveredP101.customerId,
    order_id: deliveredP101.orderId,
    run_mode: deliveredP101.runMode,
  };
  return validateP201(candidate, deliveredP101);
}

function maskClientName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "***";
  return parts.map((part) => `${part[0] ?? "*"}***`).join(" ");
}

function maskClientEmail(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex <= 0) return "***";
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  return `${local[0] ?? "*"}***@${domain}`;
}

/**
 * Masks personal `client_name` and `client_email` fields for non-admin (`staff`) previewers.
 */
export function maskP101PayloadForRole(
  payload: P101Payload,
  role: UserRole,
): { payload: P101Payload; maskedForViewer: boolean } {
  if (role === "admin") {
    return { payload: { ...payload }, maskedForViewer: false };
  }
  return {
    payload: {
      ...payload,
      client_name: maskClientName(payload.client_name),
      client_email: maskClientEmail(payload.client_email),
    },
    maskedForViewer: true,
  };
}

/**
 * Masks a secret webhook URL down to `{ host, last4 }` only — never exposes path, query, or embedded tokens.
 */
export function maskSecretWebhookUrl(rawUrl: string | null | undefined): { host: string; last4: string } | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    const trimmed = rawUrl.trim();
    const last4 = trimmed.length >= 4 ? trimmed.slice(-4) : "****";
    return { host: parsed.host.toLowerCase(), last4 };
  } catch {
    return null;
  }
}
