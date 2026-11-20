/**
 * The ReadyPackets offerings document (data/catalog/readypackets-offerings-v3.0.json): the catalog as data,
 * transcribed verbatim from docs/source-specs/increment-02/PRODUCT_MATRIX_v3.0.md (ADR 0022).
 *
 * This Zod schema is the source of truth; data/catalog/offerings.schema.json is generated from it
 * (buildOfferingsJsonSchema) and a test fails when the committed file is stale.
 *
 * Packet 7 is the bundle rule (not a product). Packet 8 is reserved/unlisted and appears ONLY under
 * `reserved` with no deliverables, prices or tiers; the loader never turns it into a catalog entry.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const OFFERINGS_SCHEMA_ID = "readypackets.offerings/1";
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DEFAULT_OFFERINGS_FILE = path.join(REPO_ROOT, "data", "catalog", "readypackets-offerings-v3.0.json");
export const OFFERINGS_JSON_SCHEMA_FILE = path.join(REPO_ROOT, "data", "catalog", "offerings.schema.json");

export const TIERS = ["Basic", "Standard", "Premium"] as const;
export type Tier = (typeof TIERS)[number];

/** Single-line, trimmed, no markdown artefacts (`**`, `\$`, backticks) and no control characters. */
const Text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^\S(?:[^\p{Cc}*\\`]*\S)?$/u, "single-line trimmed text without markdown artefacts");

export const DeliverableSchema = z.strictObject({ title: Text(200), detail: Text(2000) });

export const TierOfferingSchema = z.strictObject({
  tier: z.enum(TIERS),
  productKey: z.string().regex(/^packet-[1-6]-(basic|standard|premium)$/),
  name: Text(160),
  /** USD minor units (cents). */
  priceMinor: z.number().int().positive().max(100_000_000),
  outcome: Text(1000),
  timeline: Text(120),
  /** The lower tier this tier builds on ("Everything in X, plus:"), or null for Basic. */
  includesTier: z.enum(["Basic", "Standard"]).nullable(),
  deliverables: z.array(DeliverableSchema).min(1).max(50),
});

export const PacketSchema = z.strictObject({
  packetNumber: z.number().int().min(1).max(6),
  groupKey: z.string().regex(/^packet-[1-6]$/),
  name: Text(120),
  tiers: z.array(TierOfferingSchema).length(3),
});

export const BundleSchema = z.strictObject({
  packetNumber: z.literal(7),
  name: Text(120),
  tierLabel: Text(120),
  requiredPacketNumbers: z.array(z.number().int().min(1).max(6)).min(1).max(6),
  discountPercent: z.number().int().min(1).max(50),
  pricingNote: Text(500),
  outcome: Text(2000),
  timeline: Text(100),
  points: z.array(DeliverableSchema).min(1).max(10),
});

export const ReservedSchema = z.strictObject({
  packetNumber: z.number().int().min(7),
  name: Text(200),
  listed: z.literal(false),
  reason: Text(500),
});

export const OfferingsSchema = z
  .strictObject({
    schema: z.literal(OFFERINGS_SCHEMA_ID),
    matrixVersion: z.string().regex(/^\d+\.\d+$/),
    currency: z.literal("USD"),
    source: z.string().min(1).max(300),
    packets: z.array(PacketSchema).min(1).max(6),
    bundle: BundleSchema,
    reserved: z.array(ReservedSchema).max(5),
  })
  .superRefine((doc, ctx) => {
    const issue = (message: string, p: (string | number)[]) => ctx.addIssue({ code: "custom", message, path: p });
    const groupKeys = new Set<string>();
    const productKeys = new Set<string>();
    const numbers = new Set<number>();
    doc.packets.forEach((packet, i) => {
      if (packet.groupKey !== `packet-${packet.packetNumber}`) issue("groupKey must be packet-<packetNumber>", ["packets", i, "groupKey"]);
      if (numbers.has(packet.packetNumber)) issue("duplicate packetNumber", ["packets", i, "packetNumber"]);
      if (groupKeys.has(packet.groupKey)) issue("duplicate groupKey", ["packets", i, "groupKey"]);
      numbers.add(packet.packetNumber);
      groupKeys.add(packet.groupKey);
      packet.tiers.forEach((t, j) => {
        const at = ["packets", i, "tiers", j];
        if (t.tier !== TIERS[j]) issue(`tiers must be ordered ${TIERS.join(", ")}`, [...at, "tier"]);
        if (t.productKey !== `${packet.groupKey}-${t.tier.toLowerCase()}`) issue("productKey must be <groupKey>-<tier>", [...at, "productKey"]);
        if (productKeys.has(t.productKey)) issue("duplicate productKey", [...at, "productKey"]);
        productKeys.add(t.productKey);
        const expectIncludes = j === 0 ? null : TIERS[j - 1];
        if (t.includesTier !== expectIncludes) issue(`includesTier must be ${String(expectIncludes)}`, [...at, "includesTier"]);
        if (t.name !== `${packet.name} — ${t.tier}`) issue("name must be '<packet name> — <tier>'", [...at, "name"]);
      });
    });
    for (const n of doc.bundle.requiredPacketNumbers) {
      if (!numbers.has(n)) issue(`bundle requires unknown packet ${n}`, ["bundle", "requiredPacketNumbers"]);
    }
    if (new Set(doc.bundle.requiredPacketNumbers).size !== doc.bundle.requiredPacketNumbers.length) {
      issue("duplicate required packet", ["bundle", "requiredPacketNumbers"]);
    }
    doc.reserved.forEach((r, i) => {
      if (numbers.has(r.packetNumber) || r.packetNumber === doc.bundle.packetNumber) issue("reserved packet collides with a listed packet", ["reserved", i, "packetNumber"]);
    });
  });

export type Offerings = z.infer<typeof OfferingsSchema>;
export type PacketOffering = z.infer<typeof PacketSchema>;
export type TierOffering = z.infer<typeof TierOfferingSchema>;
export type BundleOffering = z.infer<typeof BundleSchema>;

export class OfferingsFileError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "OfferingsFileError";
  }
}

const MAX_FILE_BYTES = 1024 * 1024;

/** Parses and validates an offerings document; throws OfferingsFileError (with issue paths, never data) on failure. */
export function parseOfferings(raw: string): Offerings {
  if (Buffer.byteLength(raw, "utf8") > MAX_FILE_BYTES) throw new OfferingsFileError("offerings file too large");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new OfferingsFileError("offerings file is not valid JSON");
  }
  const result = OfferingsSchema.safeParse(json);
  if (!result.success) {
    throw new OfferingsFileError(
      "offerings file failed schema validation",
      result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return result.data;
}

export async function loadOfferings(file: string = DEFAULT_OFFERINGS_FILE): Promise<Offerings> {
  return parseOfferings(await readFile(file, "utf8"));
}

/** JSON Schema (draft 2020-12) for data/catalog/offerings.schema.json (structural rules; cross-field rules are in the loader). */
export function buildOfferingsJsonSchema(): string {
  const doc = {
    $id: "https://schemas.readypackets.example/catalog/offerings-1.schema.json",
    title: "ReadyPackets offerings document (readypackets.offerings/1)",
    description:
      "Generated from scripts/ops/catalog/offerings.ts. Cross-field rules (key formats per packet, tier order, includesTier chaining, bundle references) are enforced by the loader.",
    ...z.toJSONSchema(OfferingsSchema, { target: "draft-2020-12", unrepresentable: "any", io: "input" }),
  };
  return JSON.stringify(doc, null, 2) + "\n";
}
