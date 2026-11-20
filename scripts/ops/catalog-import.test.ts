import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { offeringsImportSchema, type OfferingsImportInput, type OfferingsImportResult } from "../../server/modules/orders/catalog.js";
import { DEFAULT_OFFERINGS_FILE, parseOfferings } from "./catalog/offerings.js";
import { CATALOG_IMPORT_ACTOR, parseArgs, renderOutcome, runCatalogImport, toImportInput, type ImportOfferings } from "./catalog-import.js";

const RESULT: OfferingsImportResult = {
  dryRun: false,
  groups: { created: 6, updated: 0, unchanged: 0 },
  products: { created: 18, versioned: 0, unchanged: 0 },
  bundleRule: "created",
};
const doc = parseOfferings(readFileSync(DEFAULT_OFFERINGS_FILE, "utf8"));
const tmp = mkdtempSync(path.join(tmpdir(), "rp-catalog-import-"));

describe("catalog-import", () => {
  it("maps the data file onto a service input the orders schema accepts (packets 1-6 + bundle, no Packet 8)", () => {
    const input = toImportInput(doc);
    expect(offeringsImportSchema.safeParse(input).success).toBe(true);
    expect(input.packets.map((p) => p.packetNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(input.packets.flatMap((p) => p.tiers)).toHaveLength(18);
    expect(input.bundle).toEqual({ requiredPacketNumbers: [1, 2, 3, 4, 5, 6], discountPercent: 15, label: "The All-In (Master Bundle)" });
    expect(JSON.stringify(input)).not.toMatch(/Capital & Valuation|includesTier|reserved/);
    expect(input.packets[0]!.tiers[1]).toMatchObject({ tier: "Standard", productKey: "packet-1-standard", priceMinor: 135_000, timeline: "4 - 6 business days" });
    expect(CATALOG_IMPORT_ACTOR).toEqual({ system: "ops.catalog_import" });
  });

  it("parses flags and rejects unknown or incomplete ones", () => {
    expect(parseArgs([])).toEqual({ ok: true, args: { file: DEFAULT_OFFERINGS_FILE, dryRun: false } });
    expect(parseArgs(["--dry-run", "--file", "x.json"], "/srv/rp")).toEqual({ ok: true, args: { file: "/srv/rp/x.json", dryRun: true } });
    expect(parseArgs(["--file"])).toEqual({ ok: false, help: false });
    expect(parseArgs(["--file", "--dry-run"])).toEqual({ ok: false, help: false });
    expect(parseArgs(["--force"])).toEqual({ ok: false, help: false });
    expect(parseArgs(["--help"])).toEqual({ ok: false, help: true });
  });

  it("passes dry-run through and summarises the service result", async () => {
    const importer = vi.fn<ImportOfferings>(async (_input: OfferingsImportInput, opts) => ({ ...RESULT, dryRun: opts.dryRun }));
    const outcome = await runCatalogImport(importer, { file: DEFAULT_OFFERINGS_FILE, dryRun: true });
    expect(importer).toHaveBeenCalledTimes(1);
    expect(importer.mock.calls[0]![1]).toEqual({ dryRun: true });
    expect(outcome).toMatchObject({ status: "dry_run", packets: 6, products: 18 });
    const lines = renderOutcome(outcome, DEFAULT_OFFERINGS_FILE);
    expect(lines[0]).toMatch(/^Dry run \(rolled back, nothing changed\): 6 packets, 18 products/);
    expect(lines).toContain("  products: 18 created, 0 new versions, 0 unchanged");
    expect(lines).toContain("  bundle rule: created");
    const applied = await runCatalogImport(importer, { file: DEFAULT_OFFERINGS_FILE, dryRun: false });
    expect(applied.status).toBe("imported");
  });

  it("refuses invalid or unreadable files before calling the catalog service", async () => {
    const importer = vi.fn<ImportOfferings>(async () => RESULT);
    const bad = JSON.parse(readFileSync(DEFAULT_OFFERINGS_FILE, "utf8")) as { packets: { tiers: { priceMinor: number }[] }[] };
    bad.packets[0]!.tiers[0]!.priceMinor = -1;
    const badFile = path.join(tmp, "bad.json");
    writeFileSync(badFile, JSON.stringify(bad));
    const invalid = await runCatalogImport(importer, { file: badFile, dryRun: false });
    expect(invalid).toMatchObject({ status: "invalid_file" });
    expect(renderOutcome(invalid, badFile).join("\n")).toMatch(/schema validation[\s\S]*packets\.0\.tiers\.0\.priceMinor/);
    const notJson = path.join(tmp, "x.json");
    writeFileSync(notJson, "{");
    expect(await runCatalogImport(importer, { file: notJson, dryRun: false })).toMatchObject({ status: "invalid_file" });
    expect(await runCatalogImport(importer, { file: path.join(tmp, "missing.json"), dryRun: false })).toEqual({ status: "unreadable_file" });
    expect(await runCatalogImport(importer, { file: tmp, dryRun: false })).toEqual({ status: "unreadable_file" });
    expect(importer).not.toHaveBeenCalled();
  });
});
