/**
 * Legacy v1/v2 payload shapes, derived from the reference source
 * (ReadyPackets-SiteSplit-main/scripts/portableDataTransfer.ts + portableTransferBatch.ts):
 *   envelope: one JSON line {format, kdf:"scrypt", salt, iv, tag, ciphertext} (base64url),
 *             scrypt N=2^15 r=8 p=1 → 32-byte key, salt 16 B, IV 12 B, AES-256-GCM, AAD = payload format string.
 *   payload:  {format, sourceSystemRef, generatedAt, sourceRelease, scope, contents:{customers,orders,files}, packageId}
 *             packageId = SHA-256(JSON.stringify(payload without packageId)) — the source only checked its shape.
 * Field bounds mirror the source validator (validatePackage / validateBatchPackage).
 */
import { z } from "zod";

export const V1_FORMAT = "readypackets.portable-data-transfer.v1";
export const V1_ENVELOPE = "readypackets.portable-data-transfer-envelope.v1";
export const V2_FORMAT = "readypackets.portable-data-transfer.v2";
export const V2_ENVELOPE = "readypackets.portable-data-transfer-envelope.v2";

const b64url = z.string().min(1).max(400 * 1024 * 1024).regex(/^[A-Za-z0-9_-]+$/);
export const LegacyEnvelope = z.strictObject({
  format: z.enum([V1_ENVELOPE, V2_ENVELOPE]),
  kdf: z.literal("scrypt"),
  salt: b64url,
  iv: b64url,
  tag: b64url,
  ciphertext: b64url,
});

const ref = z.string().regex(/^[a-f0-9]{64}$/);
const enumv = z.string().regex(/^[a-z][a-z0-9_:-]{0,63}$/);
const noNul = (max: number) => z.string().max(max).refine((v) => !v.includes(String.fromCharCode(0)));
const ts = z.string().regex(/^\d{4}-\d{2}-\d{2}T/).refine((v) => Number.isFinite(Date.parse(v)));
const cents = z.int().min(-100_000_000).max(100_000_000);

export const LegacyCustomer = z.looseObject({
  ref,
  email: noNul(190),
  firstName: noNul(255).nullable(),
  middleName: noNul(255).nullable(),
  lastName: noNul(255).nullable(),
  preferredName: noNul(255).nullable(),
  suffix: noNul(255).nullable(),
  company: noNul(255).nullable(),
  phone: noNul(255).nullable(),
  address: noNul(1000).nullable(),
  timezone: z.string().min(1).max(64).refine((v) => !/[\r\n]/.test(v) && !v.includes(String.fromCharCode(0))),
  marketingOptIn: z.boolean(),
  status: enumv,
});

export const LegacyItem = z.looseObject({
  sku: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  name: noNul(190),
  tier: enumv,
  unitPriceCents: cents,
  quantity: z.int().min(1).max(10_000),
  lineTotalCents: cents,
});

export const LegacyHistory = z.looseObject({
  fromStatus: enumv.nullable(),
  toStatus: enumv,
  reason: noNul(255).nullable(),
  occurredAt: ts,
});

export const LegacyOrder = z.looseObject({
  ref,
  customerRef: ref,
  orderNumber: z.string().regex(/^[A-Za-z0-9-]{3,64}$/),
  projectName: noNul(500).nullable(),
  internalNotes: noNul(20_000).nullable(),
  status: enumv,
  paymentStatus: enumv,
  paymentRequirement: enumv,
  subtotalCents: cents,
  discountCents: cents,
  totalCents: cents,
  priceSource: enumv,
  manualPriceCents: z.int().min(0).max(100_000_000).nullable(),
  isTestOrder: z.boolean(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  bundleApplied: z.boolean(),
  integrityChoice: noNul(500).nullable(),
  mndaAcceptedAt: ts.nullable(),
  intakeCompletedAt: ts.nullable(),
  phase2ScheduledAt: ts.nullable(),
  deliveredAt: ts.nullable(),
  closedAt: ts.nullable(),
  dueAt: ts.nullable(),
  completionPercent: z.int().min(0).max(100),
  createdAt: ts,
  items: z.array(LegacyItem).max(50),
  statusHistory: z.array(LegacyHistory).max(500),
});

export const LegacyFile = z.looseObject({
  ref,
  orderRef: ref,
  originalName: noNul(255).min(1),
  detectedMime: noNul(128).min(1),
  extension: z.string().regex(/^[a-z0-9]{1,16}$/).nullable(),
  sizeBytes: z.int().min(1).max(128 * 1024 * 1024),
  durationSeconds: z.int().min(0).max(86_400).nullable(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  category: enumv,
  phase: enumv,
  visibleToCustomer: z.boolean(),
  version: z.int().min(1).max(10_000),
  createdAt: ts,
  contents: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

export const LegacyPayload = z.looseObject({
  format: z.enum([V1_FORMAT, V2_FORMAT]),
  packageId: z.string().regex(/^[a-f0-9]{64}$/),
  sourceSystemRef: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: ts,
  sourceRelease: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  scope: z.enum(["customer", "order", "file"]),
  contents: z.object({
    customers: z.array(LegacyCustomer).max(10_000),
    orders: z.array(LegacyOrder).max(10_000),
    files: z.array(LegacyFile).max(10_000),
  }),
});
export type LegacyPayload = z.infer<typeof LegacyPayload>;
