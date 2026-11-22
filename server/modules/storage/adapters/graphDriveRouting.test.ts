/**
 * Increment 04 part B, package W: nested folder routing, SharePoint/OneDrive name rules, same-name conflicts
 * and the real target path. LOCAL Graph protocol fake only; nothing here has touched a real tenant.
 */
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { StorageAdapterError } from "../contracts.js";
import { UPLOAD_CHUNK, createGraphDriveAdapter } from "./graphDrive.js";
import { FakeGraph } from "./graphDriveFake.js";
import { MAX_DECODED_PATH, MAX_SEGMENT, conflictVariant, fitFileName, safeDriveName, splitExtension } from "./graphDriveNames.js";

const TENANT = "33333333-3333-4333-8333-333333333333";
const CLIENT = "44444444-4444-4444-8444-444444444444";
/** Decoded server-relative path of the fake library ("https://contoso.sharepoint.com/sites/Orders/Shared%20Documents"). */
const LIBRARY = "sites/Orders/Shared Documents";
const DEEP = ["customers", "RPCUS-ABC123", "orders", "RP-2026-0001", "intake", "audio", "2026", "11"];

function setup(rootFolderPath = "Portal") {
  const graph = new FakeGraph();
  const adapter = createGraphDriveAdapter(graph, { tenantId: TENANT, clientId: CLIENT, driveId: graph.libraryDrive.id, rootFolderPath }, { clientSecret: graph.validSecret });
  return { graph, adapter };
}

const input = (bytes: Buffer, name: string, path: string[] = DEEP) => ({
  path, name, size: bytes.length, sha256: "0".repeat(64), contentType: "application/octet-stream", body: Readable.from([bytes]),
});

async function rejectsWith(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(StorageAdapterError);
  expect((error as StorageAdapterError).code).toBe(code);
}

const folderCount = (graph: FakeGraph) => [...graph.libraryDrive.items.values()].filter((i) => i.folder).length;
const writes = (graph: FakeGraph) => graph.calls.filter((c) => c.method !== "GET");

describe("drive name rules (pure)", () => {
  it("maps reserved characters, names and edges deterministically and idempotently", () => {
    const cases: [string, boolean, boolean, string][] = [
      ['a"b*c:d<e>f?g|h', true, false, "a_b_c_d_e_f_g_h"],
      ["  spaced name. . ", false, false, "spaced name"],
      ["CON", false, false, "CON_"],
      ["con.txt", true, false, "con_.txt"],
      ["LPT9.tar.gz", true, false, "LPT9_.tar.gz"],
      ["Console", false, false, "Console"],
      ["desktop.ini", true, false, "desktop_.ini"],
      [".lock", true, false, "_.lock"],
      ["~$draft.docx", true, false, "~_draft.docx"],
      ["a_vti_b", false, false, "a_vti-b"],
      ["Forms", false, true, "Forms_"],
      ["Forms", false, false, "Forms"],
      ["tab\tand\u202eformat\u0000", true, false, "tabandformat"],
      ["...", false, false, "_"],
      ["e\u0301", true, false, "\u00e9"],
    ];
    for (const [raw, file, topLevel, expected] of cases) {
      const mapped = safeDriveName(raw, { file, topLevel });
      expect(mapped, raw).toBe(expected);
      expect(safeDriveName(mapped, { file, topLevel }), `idempotent: ${raw}`).toBe(mapped);
    }
  });

  it("shortens long names with a stable hash, keeping the extension, and fits the 400-character path", () => {
    const long = `${"x".repeat(300)}.pdf`;
    const a = safeDriveName(long, { file: true });
    expect(a).toHaveLength(MAX_SEGMENT);
    expect(a).toMatch(/^x+~[0-9a-f]{8}\.pdf$/u);
    expect(safeDriveName(long, { file: true })).toBe(a);
    expect(safeDriveName(`${"x".repeat(300)}.doc`, { file: true }).slice(0, -4)).not.toBe(a.slice(0, -4));
    const fitted = fitFileName(350, "report.pdf".padStart(80, "r"), "raw");
    expect(fitted).not.toBeNull();
    expect(350 + 1 + fitted!.length + " (99)".length).toBeLessThanOrEqual(MAX_DECODED_PATH);
    expect(fitted).toMatch(/~[0-9a-f]{8}\.pdf$/u);
    expect(fitFileName(390, "a.pdf", "a.pdf")).toBeNull();
    expect(fitFileName(10, "short.pdf", "short.pdf")).toBe("short.pdf");
    expect(conflictVariant("a.tar.gz", 2)).toBe("a.tar (2).gz");
    expect(conflictVariant("README", 1)).toBe("README (1)");
    expect(splitExtension(".hidden")).toEqual([".hidden", ""]);
  });
});

describe("graph drive folder routing (local Graph fake)", () => {
  it("creates an 8-segment folder path once and reuses it on re-runs", async () => {
    const { adapter, graph } = setup();
    const first = await adapter.put(input(randomBytes(100), "a.webm"));
    const folders = folderCount(graph);
    expect(first.targetPath).toEqual([...DEEP, "a.webm"]);
    await adapter.ensureFolder(DEEP);
    const second = await adapter.put(input(randomBytes(100), "b.webm"));
    expect(folderCount(graph)).toBe(folders);
    expect(second.targetPath).toEqual([...DEEP, "b.webm"]);
    expect(graph.findByPath(graph.libraryDrive, ["Portal", ...DEEP, "b.webm"])).not.toBeNull();
  });

  it("concurrent uploads into a new folder create each folder once and never overwrite", async () => {
    const { adapter, graph } = setup();
    const distinct = Array.from({ length: 6 }, (_, i) => randomBytes(64 + i));
    const sameName = Array.from({ length: 3 }, () => randomBytes(500));
    const identical = randomBytes(300);
    const results = await Promise.all([
      ...distinct.map((b, i) => adapter.put(input(b, `file-${i}.bin`))),
      ...sameName.map((b) => adapter.put(input(b, "clash.bin"))),
      ...[0, 1, 2].map(() => adapter.put(input(identical, "same.bin"))),
    ]);
    // One folder per segment: root + Portal + 8 segments.
    expect(folderCount(graph)).toBe(1 + 1 + DEEP.length);
    const clash = results.slice(6, 9).map((r) => r.targetPath!.at(-1)).sort();
    expect(clash).toEqual(["clash (1).bin", "clash (2).bin", "clash.bin"]);
    for (const [i, r] of results.slice(6, 9).entries()) {
      expect(graph.findByPath(graph.libraryDrive, ["Portal", ...r.targetPath!])?.content?.equals(sameName[i]!)).toBe(true);
    }
    const same = results.slice(9);
    expect(new Set(same.map((r) => r.remoteId)).size).toBe(1);
    expect(same.every((r) => r.targetPath!.at(-1) === "same.bin")).toBe(true);
    expect([...graph.libraryDrive.items.values()].filter((i) => !i.folder)).toHaveLength(6 + 3 + 1);
  });

  it("concurrent large uploads of the same name commit once each, never replacing the other", async () => {
    const { adapter, graph } = setup();
    const a = randomBytes(UPLOAD_CHUNK + 7);
    const b = randomBytes(UPLOAD_CHUNK + 7);
    const settled = await Promise.allSettled([adapter.put(input(a, "big.bin")), adapter.put(input(b, "big.bin"))]);
    const ok = settled.filter((s): s is PromiseFulfilledResult<Awaited<ReturnType<typeof adapter.put>>> => s.status === "fulfilled");
    // Either both found distinct names, or the loser saw a commit-time conflict (retryable, nothing committed).
    for (const s of settled) {
      if (s.status === "rejected") expect(s.reason).toMatchObject({ code: "DESTINATION_CONFLICT", retryable: true });
    }
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const files = [...graph.libraryDrive.items.values()].filter((i) => !i.folder);
    expect(files).toHaveLength(ok.length);
    expect(new Set(files.map((f) => f.name.toLowerCase())).size).toBe(files.length);
  });

  it("reuses an identical large file without committing, and suffixes a different one of the same size", async () => {
    const { adapter, graph } = setup();
    const bytes = randomBytes(UPLOAD_CHUNK + 99);
    const first = await adapter.put(input(bytes, "rec.webm"));
    const commitsBefore = graph.calls.filter((c) => c.kind === "upload" && c.method === "PUT").length;
    const again = await adapter.put(input(bytes, "rec.webm"));
    expect(again.remoteId).toBe(first.remoteId);
    // Only the first chunk was sent; the final chunk was withheld and the session cancelled.
    expect(graph.calls.filter((c) => c.kind === "upload" && c.method === "PUT").length - commitsBefore).toBe(1);
    expect(graph.sessions.size).toBe(0);
    const other = await adapter.put(input(randomBytes(UPLOAD_CHUNK + 99), "rec.webm"));
    expect(other.targetPath!.at(-1)).toBe("rec (1).webm");
    expect(graph.findByPath(graph.libraryDrive, ["Portal", ...DEEP, "rec.webm"])?.content?.equals(bytes)).toBe(true);
  });

  it("maps reserved names before writing and records the real final path (drive casing)", async () => {
    const { adapter, graph } = setup("");
    graph.libraryDrive.items.set("pre", { id: "pre", name: "Customers", parentId: graph.libraryDrive.rootId, folder: true });
    const r = await adapter.put(input(randomBytes(20), "desktop.ini", ["customers", "CON", "x*y. ", "forms"]));
    expect(r.targetPath).toEqual(["Customers", "CON_", "x_y", "forms", "desktop_.ini"]);
    const top = await adapter.put(input(randomBytes(20), "a.txt", ["Forms"]));
    expect(top.targetPath).toEqual(["Forms_", "a.txt"]);
    const created = [...graph.libraryDrive.items.values()].map((i) => i.name);
    expect(created).not.toContain("CON");
    expect(created).not.toContain("customers");
  });

  it("enforces the 400-character decoded path, including the library path, before any write", async () => {
    const { adapter, graph } = setup("Portal");
    const longFolders = Array.from({ length: 8 }, (_, i) => `${i}`.padEnd(46, "f"));
    // LIBRARY (29) + "/Portal" (7) + 8 × "/" + 46 = 404 > 400: refused before any folder write.
    expect(LIBRARY.length + 7 + 8 * 47).toBeGreaterThan(MAX_DECODED_PATH);
    await rejectsWith(adapter.put(input(randomBytes(5), "a.pdf", longFolders)), "INVALID_INPUT");
    expect(writes(graph)).toHaveLength(0);

    const folders = longFolders.map((f) => f.slice(0, 38)); // 29 + 7 + 8 × 39 = 348
    const r = await adapter.put(input(randomBytes(5), `${"n".repeat(120)}.pdf`, folders));
    const finalName = r.targetPath!.at(-1)!;
    expect(finalName).toMatch(/~[0-9a-f]{8}\.pdf$/u);
    expect([LIBRARY, "Portal", ...r.targetPath!].join("/").length + " (99)".length).toBeLessThanOrEqual(MAX_DECODED_PATH);
    // Deterministic: a re-run maps to the same name and reuses the item.
    const again = await adapter.put(input((graph.findByPath(graph.libraryDrive, ["Portal", ...r.targetPath!])!.content)!, `${"n".repeat(120)}.pdf`, folders));
    expect(again.remoteId).toBe(r.remoteId);
  });

  it("refuses traversal segments without any provider call", async () => {
    const { adapter, graph } = setup();
    for (const path of [["..", "x"], ["a/../b"], ["a\\b"], ["."], [""], [" "]]) {
      await rejectsWith(adapter.ensureFolder(path), "INVALID_INPUT");
    }
    await rejectsWith(adapter.ensureFolder(Array.from({ length: 13 }, () => "a")), "INVALID_INPUT");
    expect(graph.calls).toHaveLength(0);
  });
});
