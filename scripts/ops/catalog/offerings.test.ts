import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OFFERINGS_FILE,
  OFFERINGS_JSON_SCHEMA_FILE,
  OfferingsFileError,
  TIERS,
  buildOfferingsJsonSchema,
  parseOfferings,
  resolveDataRoot,
} from "./offerings.js";

const raw = readFileSync(DEFAULT_OFFERINGS_FILE, "utf8");
const doc = parseOfferings(raw);
const MATRIX = readFileSync(path.join(path.dirname(DEFAULT_OFFERINGS_FILE), "..", "..", "docs", "source-specs", "increment-02", "PRODUCT_MATRIX_v3.0.md"), "utf8");

/** Matrix text with markdown artefacts removed and whitespace collapsed, so wrapped lines compare verbatim. */
const normalise = (s: string) => s.replace(/\\\$/g, "$").replace(/\*\*/g, "").replace(/\s+/g, " ");
const RESERVED_START = MATRIX.indexOf("### **1. Packet 8");
const listedText = normalise(MATRIX.slice(0, RESERVED_START));
const reservedText = normalise(MATRIX.slice(RESERVED_START));

/** Independently typed from the matrix (USD whole dollars): [Basic, Standard, Premium]. */
const PRICES: Record<number, [number, number, number]> = {
  1: [450, 1350, 2450],
  2: [1500, 3500, 7000],
  3: [910, 2800, 5000],
  4: [1200, 1715, 2450],
  5: [770, 1995, 4550],
  6: [910, 1960, 3255],
};
const TIMELINES: Record<number, [string, string, string]> = {
  1: ["48-72 hours", "4 - 6 business days", "7 - 10 business days"],
  2: ["48-72 hours", "3 - 5 business days", "5 - 7 business days"],
  3: ["48-72 hours", "3 - 5 business days", "5 - 7 business days"],
  4: ["1 - 4 business days", "3 - 6 business days", "5 - 7 business days"],
  5: ["48-72 hours", "3 - 5 business days", "5 - 7 business days"],
  6: ["5 - 7 business days", "7 - 10 business days", "10 - 14 business days"],
};
const NAMES = ["Idea & IP Protection", "Business Foundation", "Business Plans", "Operating Design", "Execution & Partnerships", "Launch & Revenue Ready"];

const allStrings = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(allStrings) : value && typeof value === "object" ? Object.values(value).flatMap(allStrings) : [];

describe("offerings data file (matrix v3.0)", () => {
  it("lists packets 1-6, each with Basic/Standard/Premium and unique keys", () => {
    expect(doc.packets.map((p) => p.packetNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(doc.packets.map((p) => p.name)).toEqual(NAMES);
    const productKeys = doc.packets.flatMap((p) => p.tiers.map((t) => t.productKey));
    expect(productKeys).toHaveLength(18);
    expect(new Set(productKeys).size).toBe(18);
    expect(new Set(doc.packets.map((p) => p.groupKey)).size).toBe(6);
    for (const p of doc.packets) {
      expect(p.tiers.map((t) => t.tier)).toEqual([...TIERS]);
      expect(p.tiers.map((t) => t.includesTier)).toEqual([null, "Basic", "Standard"]);
    }
  });

  it("carries the 18 matrix prices and timelines exactly", () => {
    for (const p of doc.packets) {
      expect(p.tiers.map((t) => t.priceMinor)).toEqual(PRICES[p.packetNumber]!.map((usd) => usd * 100));
      expect(p.tiers.map((t) => t.timeline)).toEqual(TIMELINES[p.packetNumber]);
    }
  });

  it("copies every outcome, deliverable title and detail verbatim from the listed part of the matrix", () => {
    let checked = 0;
    for (const p of doc.packets) {
      for (const t of p.tiers) {
        for (const text of [t.outcome, ...t.deliverables.flatMap((d) => [d.title, d.detail])]) {
          expect(listedText, `${t.productKey}: ${text.slice(0, 40)}`).toContain(text);
          checked++;
        }
      }
    }
    for (const text of [doc.bundle.outcome, doc.bundle.pricingNote, ...doc.bundle.points.flatMap((d) => [d.title, d.detail])]) {
      expect(listedText).toContain(text);
      checked++;
    }
    expect(checked).toBe(18 + 2 * 112 + 2 + 6);
  });

  it("models Packet 7 as the 15% bundle rule over packets 1-6", () => {
    expect(doc.bundle).toMatchObject({ packetNumber: 7, requiredPacketNumbers: [1, 2, 3, 4, 5, 6], discountPercent: 15, timeline: "30–45 Business Days" });
    expect(doc.bundle.points.find((x) => x.title === "The Advantage")?.detail).toBe(
      "When you commit to a full 6-Packet bundle, we apply a flat 15% discount to your total project cost.",
    );
  });

  it("keeps Packet 8 only under reserved and excludes the Architect's Legacy Note appendix", () => {
    expect(doc.reserved).toEqual([expect.objectContaining({ packetNumber: 8, name: "Capital & Valuation Services", listed: false })]);
    expect(Object.keys(doc.reserved[0]!).sort()).toEqual(["listed", "name", "packetNumber", "reason"]);
    expect(doc.packets.some((p) => p.packetNumber === 8)).toBe(false);
    expect(raw).not.toMatch(/Legacy|2027|Strategic Reserve|12,000|1200000|Institutional \(/);
    // No sentence that exists only in the reserved/appendix part of the matrix leaks into the file.
    const listedStrings = allStrings({ packets: doc.packets, bundle: doc.bundle }).filter((s) => s.length >= 25);
    const leaked = listedStrings.filter((s) => reservedText.includes(s) && !listedText.includes(s));
    expect(leaked).toEqual([]);
  });

  it("matches the committed JSON Schema (regenerate: tsx scripts/ops/catalog/export-schema.ts)", () => {
    expect(readFileSync(OFFERINGS_JSON_SCHEMA_FILE, "utf8")).toBe(buildOfferingsJsonSchema());
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("finds data/catalog from the source layout and from the bundled dist/ops layout", () => {
    const rel = path.join("data", "catalog", "readypackets-offerings-v3.0.json");
    const release = "/opt/readypackets/releases/abc123";
    const has = (p: string) => p === path.join(release, rel);
    expect(resolveDataRoot(path.join(release, "dist", "ops"), has)).toBe(release);
    expect(resolveDataRoot(path.join(release, "scripts", "ops", "catalog"), has)).toBe(release);
    expect(resolveDataRoot("/nowhere/a/b/c", () => false)).toBe("/nowhere");
    expect(DEFAULT_OFFERINGS_FILE.endsWith(rel)).toBe(true);
  });

  it("refuses malformed or inconsistent documents with issue paths", () => {
    const mutate = (fn: (d: Record<string, any>) => void) => {
      const copy = JSON.parse(raw) as Record<string, any>;
      fn(copy);
      return JSON.stringify(copy);
    };
    const issuesOf = (text: string) => {
      try {
        parseOfferings(text);
      } catch (error) {
        expect(error).toBeInstanceOf(OfferingsFileError);
        return (error as OfferingsFileError).issues;
      }
      throw new Error("expected rejection");
    };
    expect(() => parseOfferings("{")).toThrow("not valid JSON");
    expect(issuesOf(mutate((d) => (d.packets[0].tiers[1].productKey = "packet-1-basic"))).join()).toMatch(/productKey/);
    expect(issuesOf(mutate((d) => (d.packets[1].tiers[2].includesTier = "Basic"))).join()).toMatch(/includesTier/);
    expect(issuesOf(mutate((d) => (d.packets[0].tiers[0].priceMinor = 450.5))).join()).toMatch(/priceMinor/);
    expect(issuesOf(mutate((d) => (d.packets[0].tiers[0].deliverables[0].title = "**Bold:**"))).join()).toMatch(/title/);
    expect(issuesOf(mutate((d) => (d.bundle.requiredPacketNumbers = [1, 9]))).join()).toMatch(/requiredPacketNumbers/);
    expect(issuesOf(mutate((d) => (d.reserved[0].listed = true))).join()).toMatch(/reserved/);
    expect(issuesOf(mutate((d) => (d.extra = 1))).join()).toMatch(/root|extra|Unrecognized/i);
    expect(() => parseOfferings(" ".repeat(1024 * 1024 + 1))).toThrow("too large");
  });
});
