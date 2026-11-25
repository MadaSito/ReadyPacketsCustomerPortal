import { describe, expect, it } from "vitest";
import { isOrderFileFolderTemplate, isStageOrderFileFolderTemplate, resolveStageOrderFileFolder } from "./orderFileFolder.js";
import { DEFAULT_STAGE_FILE_SYNC, DEFAULT_STAGE_FOLDERS, stageFileSyncSchema, stageFoldersSchema } from "./orderStageFileSync.js";

describe("managed file-sync workflow fields", () => {
  it("defaults old stage values to the standard folders and no external transfers", () => {
    expect(stageFoldersSchema.parse({})).toEqual(DEFAULT_STAGE_FOLDERS);
    expect(stageFileSyncSchema.parse(undefined)).toEqual(DEFAULT_STAGE_FILE_SYNC);
    expect(stageFileSyncSchema.safeParse({ originals: "https://example.test/destination" }).success).toBe(false);
  });
  it("keeps managed tokens out of legacy templates and admits no traversal or absolute paths", () => {
    expect(isOrderFileFolderTemplate("{phase_key}/Docs")).toBe(false);
    expect(isOrderFileFolderTemplate("orders/{order_ref}/{phase}")).toBe(true);
    expect(isStageOrderFileFolderTemplate("{phase_key}/Docs")).toBe(true);
    for (const unsafe of ["../Docs", "/Docs", "a/%2e%2e/Docs", "{tenant}/Docs", "a/b/c/d/e/f/g"]) {
      expect(isStageOrderFileFolderTemplate(unsafe), unsafe).toBe(false);
    }
  });
  it("normalizes placeholder values as individual safe segments", () => {
    expect(resolveStageOrderFileFolder("{customer_folder}/{order_number}/{phase_key}/Docs", {
      customer_ref: "CUS-1", order_ref: "ORD-1", order_name: "Name", phase: "Phase", slot: "Documents",
      yyyy: "2026", mm: "11", customer_folder: "E\u0301lodie/Beispiel-CUS-1", order_number: "ORD\\1", phase_key: "intake",
    })).toEqual(["Élodie_Beispiel-CUS-1", "ORD_1", "intake", "Docs"]);
  });
});
