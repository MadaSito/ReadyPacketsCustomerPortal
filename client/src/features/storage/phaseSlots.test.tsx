import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_STAGE_FILE_SYNC, DEFAULT_STAGE_FOLDERS } from "@shared/orderStageFileSync";
import type * as TrpcModule from "@/lib/trpc";
import { renderUi } from "@/ui/testing";
import { PhaseFileSyncSlot } from "./phaseSlots";

const target = "01JD0000000000000000000088";
vi.mock("@/lib/trpc", async (importOriginal) => ({
  ...await importOriginal<typeof TrpcModule>(),
  useTRPC: () => ({ storage: { fileSync: { listTargets: {
    queryOptions: () => ({
      queryKey: ["storage", "fileSync", "listTargets"],
      queryFn: async () => [{ label: "Private library", publicId: target, kind: "sharepoint" }],
    }),
  } } } }),
}));

describe("phase file sync slot", () => {
  const props = {
    stageKey: "intake", stageIndex: 0, stageStatusKeys: ["paid"], workflowStatusKeys: ["paid"],
    idPrefix: "phase-intake", disabled: false, headingLevel: 3 as const, errors: {},
    value: { folders: DEFAULT_STAGE_FOLDERS, fileSync: DEFAULT_STAGE_FILE_SYNC },
  };
  it("defaults off, offers only approved destinations and changes the controlled role value", async () => {
    const onChange = vi.fn();
    renderUi(<PhaseFileSyncSlot {...props} onChange={onChange} />);
    const original = screen.getByLabelText("Originals") as HTMLSelectElement;
    expect(original.value).toBe("");
    expect(await screen.findAllByRole("option", { name: "Private library" })).toHaveLength(3);
    fireEvent.change(original, { target: { value: target } });
    expect(onChange).toHaveBeenCalledWith({ folders: DEFAULT_STAGE_FOLDERS, fileSync: { ...DEFAULT_STAGE_FILE_SYNC, originals: target } });
    expect(screen.getByText(/Staff-only files and audio awaiting conversion go only to Originals/)).toBeTruthy();
  });
  it("shows a saved unavailable option without auto-selecting another resource and respects read-only", async () => {
    const unavailable = "01JD0000000000000000000089";
    renderUi(<PhaseFileSyncSlot {...props} disabled value={{ ...props.value, fileSync: { ...DEFAULT_STAGE_FILE_SYNC, originals: unavailable } }}
      errors={{ "folders.audio": "Check the folder." }} onChange={vi.fn()} />);
    expect(await screen.findByRole("option", { name: "Previously selected destination (unavailable)" })).toBeTruthy();
    const original = screen.getByLabelText("Originals") as HTMLSelectElement;
    expect(original.disabled).toBe(true);
    expect(original.value).toBe(unavailable);
    expect(screen.getByText("Check the folder.")).toBeTruthy();
  });
});
