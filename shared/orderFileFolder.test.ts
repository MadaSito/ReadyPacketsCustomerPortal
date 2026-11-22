import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORDER_FILE_FOLDER_TEMPLATE, isOrderFileFolderTemplate, isResolvedOrderFileFolder, resolveOrderFileFolder,
} from "./orderFileFolder.js";

const sample = { customer_ref: "RPCUS-EXAMPLE01", order_ref: "RP-123", order_name: "../A/B", phase: "Planning",
  slot: "AUX", yyyy: "2026", mm: "11" };

describe("order file folders", () => {
  it.each(["/a", "a/", "a//b", "../b", "a/./b", "a\\b", "a/%2e%2e", "a\u0000b", "a:\u202eb",
    "a/{unknown}", "a/{slot", "a/desktop.ini", "a/LPT1", "a/_vti_hidden", "a/~$hold", "a./b",
    "a/ b", "a/b/c/d/e/f/g/h/i", "a".repeat(401)])("refuses unsafe literal input %s", (template) => {
    expect(isOrderFileFolderTemplate(template)).toBe(false);
    expect(() => resolveOrderFileFolder(template, sample)).toThrow(RangeError);
  });

  it("expands canonical tokens without creating new path segments", () => {
    expect(resolveOrderFileFolder(DEFAULT_ORDER_FILE_FOLDER_TEMPLATE, sample))
      .toEqual(["customers", "RPCUS-EXAMPLE01", "orders", "RP-123", "Planning"]);
    expect(resolveOrderFileFolder("{yyyy}/{mm}/{order_name}/{slot}", sample)).toEqual(["2026", "11", "_A_B", "unspecified"]);
  });

  it("rejects a path that becomes unsafe only after interpolation", () => {
    expect(isOrderFileFolderTemplate("{phase}N")).toBe(true);
    expect(() => resolveOrderFileFolder("{phase}N", { ...sample, phase: "CO" })).toThrow(RangeError);
    expect(() => resolveOrderFileFolder("{phase}".repeat(8), { ...sample, phase: "X".repeat(48) })).toThrow(RangeError);
    expect(isResolvedOrderFileFolder([])).toBe(false);
    expect(isResolvedOrderFileFolder(["unsafe/path"])).toBe(false);
  });
});
