import { StrictMode } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as transportModule from "@/lib/sessionTransport";
import type * as trpcModule from "@/lib/trpc";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import { PhaseArchiveAction } from "./ArchiveAction";

const { api, fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  api: {
    request: vi.fn(),
    status: vi.fn(),
    issue: vi.fn(),
  },
}));
vi.mock("@/lib/sessionTransport", async (original) => ({
  ...await original<typeof transportModule>(),
  sessionFetch: fetchMock,
  csrfToken: () => "synthetic-csrf-token",
}));
vi.mock("@/lib/trpc", async (original) => ({
  ...await original<typeof trpcModule>(),
  useTRPCClient: () => ({ fileArchives: {
    request: { mutate: api.request },
    status: { query: api.status },
    issueDownloadTicket: { mutate: api.issue },
  } }),
}));

const ORDER = "01JSGNORDER000000000000001";
const view = (over: Record<string, unknown> = {}) => ({
  archiveId: "01JSGNARCHIVE0000000000001", orderId: ORDER, scope: "stage", stageKey: "design", state: "ready", reasonCode: null,
  fileCount: 2, totalBytes: 2048, zipBytes: 2300, createdAt: "2026-11-20T12:00:00.000Z", builtAt: "2026-11-20T12:00:01.000Z",
  expiresAt: "2026-11-20T12:30:00.000Z", downloadCount: 0, ...over,
});

let submitted: { action: string; fields: Record<string, string> }[];

beforeEach(() => {
  submitted = [];
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
    submitted.push({ action: this.action, fields: Object.fromEntries(new FormData(this).entries()) as Record<string, string> });
  });
  api.request.mockReset(); api.status.mockReset(); api.issue.mockReset(); fetchMock.mockReset();
  api.issue.mockResolvedValue({ ticket: "synthetic-ticket", expiresAt: "2026-11-20T12:01:00.000Z" });
});
afterEach(() => vi.restoreAllMocks());

describe("PhaseArchiveAction", () => {
  it("queued → ready under StrictMode: native form POST with ticket + CSRF, no fetch/Blob, focus kept", async () => {
    api.request.mockResolvedValue(view({ state: "queued", zipBytes: null }));
    api.status.mockResolvedValueOnce(view()).mockResolvedValue(view({ downloadCount: 1 }));
    const user = userEvent.setup();
    renderUi(<PhaseArchiveAction orderId={ORDER} stageKey="design" phaseName="Design" />, { wrapper: (c) => <StrictMode>{c}</StrictMode> });
    const button = screen.getByRole("button", { name: /Download Design files \(ZIP\)/ });
    await user.click(button);
    await waitFor(() => expect(screen.getByText(/Your browser is saving the ZIP archive/)).toHaveAttribute("aria-live", "polite"), { timeout: 8000 });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.action).toMatch(/\/api\/files\/archives\/download$/);
    expect(submitted[0]!.fields).toEqual({ ticket: "synthetic-ticket", csrf: "synthetic-csrf-token" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector("form")).toBeNull();
    expect(document.activeElement).toBe(button);
    await expectNoAxeViolations();
  }, 15_000);

  it("reports a refused download (204, archive revoked as stale) without leaving the page", async () => {
    api.request.mockResolvedValue(view());
    api.status.mockResolvedValue(view({ state: "revoked", reasonCode: "ARCHIVE_STALE" }));
    const user = userEvent.setup();
    renderUi(<PhaseArchiveAction orderId={ORDER} stageKey="design" />);
    await user.click(screen.getByRole("button", { name: /Download phase files/ }));
    await waitFor(() => expect(screen.getByText(/The files changed since this archive was prepared/)).toBeInTheDocument(), { timeout: 5000 });
    expect(submitted).toHaveLength(1);
  }, 10_000);

  it("retries an interrupted submission with a new ticket for the same already-ready archive", async () => {
    api.request.mockResolvedValue(view({ downloadCount: 2 }));
    api.issue.mockResolvedValueOnce({ ticket: "abandoned-ticket" }).mockResolvedValueOnce({ ticket: "retry-ticket" });
    api.status.mockResolvedValue(view({ downloadCount: 3 }));
    vi.mocked(HTMLFormElement.prototype.submit).mockImplementationOnce(() => { throw new Error("Synthetic interruption"); });
    const user = userEvent.setup();
    renderUi(<PhaseArchiveAction orderId={ORDER} stageKey="design" />);
    const button = screen.getByRole("button", { name: /Download phase files/ });
    await user.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await screen.findByText(/Your browser is saving the ZIP archive/, {}, { timeout: 5000 });
    expect(api.request).toHaveBeenCalledTimes(2);
    expect(api.issue.mock.calls).toEqual([[{ archiveId: view().archiveId }], [{ archiveId: view().archiveId }]]);
    expect(submitted[0]!.fields.ticket).toBe("retry-ticket");
  }, 10_000);
});
