import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as TrpcModule from "@/lib/trpc";
import { fakeAuthApi, renderUi } from "@/ui/testing";
import { ManagedFileSyncPage } from "./ManagedFileSyncPage";

const { health, save, preview, resync } = vi.hoisted(() => ({
  health: vi.fn(), save: vi.fn(), preview: vi.fn(), resync: vi.fn(),
}));
vi.mock("@/lib/trpc", async (importOriginal) => ({
  ...await importOriginal<typeof TrpcModule>(),
  useTRPC: () => ({ storage: { fileSync: {
    health: { queryOptions: (_input: unknown, options: object) => ({ ...options, queryKey: ["file-sync-health"], queryFn: health }) },
    testTarget: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
    setTarget: { mutationOptions: () => ({ mutationFn: save }) },
    previewResync: { mutationOptions: () => ({ mutationFn: preview }) },
    resync: { mutationOptions: () => ({ mutationFn: resync }) },
  } } }),
}));

const target = {
  publicId: "01JD0000000000000000000088", label: "Private library", enabled: true, mode: null, version: 1,
  writeTested: true, kind: "sharepoint", lastSuccessAt: null, backlog: 0, blocked: 0,
};
const assuranceState = async () => ({
  mfaEnrolled: true, recoveryCodesAcknowledged: true, passkeyCount: 0, totpEnrolled: true, recoveryCodesRemaining: 8,
});
const stepUpError = Object.assign(new Error("Verify"), { data: { safe: {
  domainCode: "STEP_UP_REQUIRED", reasonCode: "STEP_UP_REQUIRED", safeMessage: "Verify", requestId: "r",
} } });

async function activate(user: ReturnType<typeof userEvent.setup>, element: HTMLElement) {
  element.focus();
  await user.keyboard("{Enter}");
}

async function verify(user: ReturnType<typeof userEvent.setup>) {
  const dialog = within(await screen.findByRole("dialog", { name: "Confirm it's you" }));
  await user.type(dialog.getByLabelText(/Password/), "synthetic test password");
  await user.type(dialog.getByLabelText(/6-digit code/), "123456");
  await activate(user, dialog.getByRole("button", { name: "Verify" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
}

describe("managed file sync keyboard actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    health.mockResolvedValue([target]);
  });

  it("keeps health locked on cancel and returns focus to results after verification", async () => {
    const user = userEvent.setup();
    renderUi(<ManagedFileSyncPage />, { api: fakeAuthApi({ assuranceState, stepUp: vi.fn().mockResolvedValue({ ok: true }) }) });
    const unlock = screen.getByRole("button", { name: "Verify identity and view destinations" });
    await activate(user, unlock);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(health).not.toHaveBeenCalled();
    await activate(user, unlock);
    await verify(user);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Destinations" })).toHaveFocus());
    expect(await screen.findByRole("heading", { name: target.label })).toBeInTheDocument();
  });

  it("resumes approval after another step-up and returns focus to the saved destination", async () => {
    const user = userEvent.setup();
    const stepUp = vi.fn().mockResolvedValue({ ok: true });
    save.mockRejectedValueOnce(stepUpError).mockImplementationOnce(async () => {
      health.mockResolvedValue([{ ...target, mode: "phase_files", version: 2 }]);
      return { ok: true };
    });
    renderUi(<ManagedFileSyncPage />, { api: fakeAuthApi({ assuranceState, stepUp }) });
    await activate(user, screen.getByRole("button", { name: "Verify identity and view destinations" }));
    await verify(user);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Approved purpose" }), "phase_files");
    screen.getByRole("checkbox").focus();
    await user.keyboard(" ");
    await activate(user, screen.getByRole("button", { name: `Save approval: ${target.label}` }));
    await verify(user);
    expect(await screen.findByText("Destination approval updated.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { name: target.label })).toHaveFocus());
    expect(stepUp).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls.map(([input]) => input)).toEqual(Array(2).fill({
      publicId: target.publicId, expectedVersion: 1, mode: "phase_files", confirm: true,
    }));
  });

  it("returns keyboard focus to preview after queuing and sends the exact preview token", async () => {
    const user = userEvent.setup();
    health.mockResolvedValue([{ ...target, mode: "phase_files" }]);
    preview.mockResolvedValue({ count: 1, previewToken: "synthetic-preview-token", inspectOnly: 0, more: false });
    resync.mockResolvedValue({ queued: 1 });
    renderUi(<ManagedFileSyncPage />, { api: fakeAuthApi({ assuranceState, stepUp: vi.fn().mockResolvedValue({ ok: true }) }) });
    await activate(user, screen.getByRole("button", { name: "Verify identity and view destinations" }));
    await verify(user);
    const trigger = await screen.findByRole("button", { name: `Preview destination resync: ${target.label}` });
    await activate(user, trigger);
    await activate(user, await screen.findByRole("button", { name: `Queue these transfers: ${target.label}` }));
    expect(await screen.findByText("1 queued.")).toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(resync).toHaveBeenCalledWith(expect.objectContaining({ scope: { scope: "target", publicId: target.publicId }, previewToken: "synthetic-preview-token" }), expect.anything());
  });
});
