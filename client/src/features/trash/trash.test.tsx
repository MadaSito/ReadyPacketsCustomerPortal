import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as trpcModule from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { Button } from "@/ui";
import { fakeAuthApi, renderUi } from "@/ui/testing";
import { bulkConfirmation, countLabel, dueText, resultSentence, retentionConfirmation, retentionError, retentionNeedsConfirmation, trashErrorMessage } from "./model";
import { lastRunText } from "./RetentionPanel";
import { MoveToTrashDialog } from "./TrashDialogs";
import TrashCentrePage, { toListInput } from "./TrashCentrePage";
import { trashFeature } from "./routes";
import { TrashNavCount } from "./TrashNavCount";

const { handlers, calls } = vi.hoisted(() => ({
  handlers: new Map<string, (input: unknown) => unknown>(),
  calls: [] as { path: string; input: unknown }[],
}));

function proxy(path: string[]): unknown {
  const key = path.join(".");
  const run = async (input: unknown) => {
    calls.push({ path: key, input });
    const handler = handlers.get(key);
    if (!handler) throw new Error(`no handler for ${key}`);
    return handler(input);
  };
  const api = {
    queryOptions: (input: unknown, opts: Record<string, unknown> = {}) => ({ queryKey: [key, input], queryFn: () => run(input), ...opts }),
    mutationOptions: (opts: Record<string, unknown> = {}) => ({ mutationFn: run, ...opts }),
    queryKey: (input?: unknown) => [key, input],
    pathKey: () => [key],
    pathFilter: () => ({ queryKey: [key] }),
    mutate: run,
    query: run,
  };
  return new Proxy(api, { get: (target, prop: string) => (prop in target ? target[prop as keyof typeof target] : proxy([...path, prop])) });
}

vi.mock("@/lib/trpc", async (original) => ({
  ...(await original<typeof trpcModule>()),
  useTRPC: () => proxy([]),
  useTRPCClient: () => proxy([]),
}));

const safe = (reasonCode: string, safeMessage = "Server message.", domainCode = "CONFLICT") =>
  Object.assign(new Error(safeMessage), { data: { safe: { domainCode, reasonCode, safeMessage } } });
const stepUpRequired = () => Object.assign(new Error("Verify first."), { data: { safe: { domainCode: "STEP_UP_REQUIRED", safeMessage: "Verify first." } } });

const row = (n: number, overrides: Record<string, unknown> = {}) => ({
  kind: "order",
  publicId: `01JTRASHORDER000000000000${n}`,
  label: `RP-2026-00${n} Synthetic Rollout`,
  reference: `RP-2026-00${n}`,
  ownerCustomerId: "RPCUS-A1B2CJJG5",
  movedBy: { publicId: "01JADMIN0000000000000000001", displayName: "Zeus Greene" },
  movedAt: new Date("2026-11-20T15:00:00Z"),
  reason: "Duplicate order",
  dueAt: new Date("2026-12-20T15:00:00Z"),
  state: "in_trash",
  batchId: `01JBATCH00000000000000000${n}`,
  failureCode: null,
  canRestore: true,
  restoreBlockedReason: null,
  unreachableExternalCopies: null,
  failedRunId: null,
  failedTargetPublicId: null,
  failedTargetReference: null,
  ...overrides,
});

const settings = (overrides: Record<string, unknown> = {}) => ({
  autoPurgeEnabled: true, orderDays: 30, customerDays: 30, version: 4,
  lastRun: { publicId: "01JRUN0000000000000000001", finishedAt: new Date("2026-11-26T03:00:00Z"), status: "completed", purged: 2, failed: 0 },
  nextDueCount: 1, ...overrides,
});

beforeEach(() => {
  handlers.clear();
  calls.length = 0;
  handlers.set("trash.list", (input) => ((input as { kind: string }).kind === "order"
    ? { items: [row(1), row(2, { canRestore: false, restoreBlockedReason: "OWNER_IN_TRASH" })], nextCursor: null, total: 2 }
    : { items: [], nextCursor: null, total: 0 }));
  handlers.set("trash.counts", () => ({ orders: 2, customers: 0, dueWithin7d: 1 }));
  handlers.set("trash.movedByOptions", () => [{ publicId: "01JADMIN0000000000000000001", displayName: "Zeus Greene" }]);
  handlers.set("trash.settings.get", () => settings());
  handlers.set("trash.summarize", () => ({ kind: "order", publicId: row(1).publicId, label: row(1).label, reference: row(1).reference, batchId: row(1).batchId, counts: { files: 3 }, cascadedOrders: 0, dueAt: new Date("2026-12-27T15:00:00Z"), autoPurgeEnabled: true, hasPayments: true }));
});
afterEach(() => vi.useRealTimers());

const renderPage = (stepUp = vi.fn().mockResolvedValue(undefined)) =>
  renderUi(<main><TrashCentrePage /></main>, {
    path: "/admin/trash",
    api: fakeAuthApi({ assuranceState: async () => ({ mfaEnrolled: true, recoveryCodesAcknowledged: true, totpEnrolled: true, passkeyCount: 0, recoveryCodesRemaining: 5 }), stepUp } as never),
  });
const heading = () => screen.findByRole("heading", { level: 2, name: /Orders in the trash \(2\)/ });
const firstButton = (name: RegExp) => screen.getAllByRole("button", { name })[0]!;
const lastCall = (path: string) => [...calls].reverse().find((c) => c.path === path)?.input as Record<string, unknown> | undefined;

describe("trash model", () => {
  it("words a single count correctly, including irregular plurals", () => {
    expect(countLabel("retainedMailCopies", 1)).toBe("1 retained mail copy");
    expect(countLabel("retainedMailCopies", 2)).toBe("2 retained mail copies");
    expect(countLabel("paidInvoices", 1)).toBe("1 paid invoice");
    expect(countLabel("billingAddresses", 1)).toBe("1 billing address");
    expect(countLabel("lineItems", 3)).toBe("3 line items");
  });

  it("words confirmations, due dates, results and retention checks", () => {
    expect(bulkConfirmation(3)).toBe("DELETE 3");
    expect(retentionConfirmation(0)).toBe("DELETE 0");
    expect(retentionConfirmation(2, "DELETE 2")).toBe("DELETE 2");
    expect(dueText(null)).toBe("Kept until an administrator deletes it");
    expect(trashErrorMessage("CUSTOMER_NOT_SUSPENDED", "x")).toBe("Suspend this account first.");
    expect(trashErrorMessage("STALE", "x")).toMatch(/Review again/);
    expect(resultSentence("order", "restored", [{ kind: "order", publicId: "a", ok: true }, { kind: "order", publicId: "b", ok: false, reasonCode: "OWNER_IN_TRASH" }])).toMatch(/1 could not be restored/);
    expect(retentionError("0")).not.toBeNull();
    expect(retentionError("3651")).not.toBeNull();
    expect(retentionError("30")).toBeNull();
    const current = { autoPurgeEnabled: true, orderDays: 30, customerDays: 30 };
    expect(retentionNeedsConfirmation(current, { ...current, orderDays: 10 })).toBe(true);
    expect(retentionNeedsConfirmation(current, { ...current, orderDays: 60 })).toBe(false);
    expect(retentionNeedsConfirmation({ ...current, autoPurgeEnabled: false }, current)).toBe(true);
    expect(lastRunText(settings() as never)).toMatch(/2/);
    const labels = new Map([["a", "RP-2026-001"], ["b", "RP-2026-002"]]);
    expect(resultSentence("order", "deleted permanently", [
      { kind: "order", publicId: "a", ok: false, reasonCode: "ORDER_ON_LEGAL_HOLD" },
      { kind: "order", publicId: "b", ok: false, reasonCode: "PURGE_IN_PROGRESS" },
    ], labels)).toBe("1 could not be deleted (RP-2026-001): Release the legal hold first. 1 could not be deleted (RP-2026-002): Permanent deletion has started for this item, so it can no longer be restored.");
  });

  it("builds list input with public-id filters and the admin route", () => {
    const input = toListInput("order", { q: " RP-2026 ", movedFrom: "2026-11-01", movedTo: "", movedBy: "01JADMIN", dueWithin: "7" }, { key: "dueAt", direction: "asc" }, null);
    expect(input).toMatchObject({ kind: "order", q: "RP-2026", movedByPublicId: "01JADMIN", dueWithinDays: 7, sort: "dueAt", dir: "asc", limit: 25 });
    expect(trashFeature.routes[0]).toMatchObject({ path: "/admin/trash", access: "admin", capability: "trash.read" });
  });
});

describe("TrashNavCount", () => {
  it("shows the total and is the nav badge", async () => {
    renderUi(<TrashNavCount />);
    expect(await screen.findByText("2")).toHaveTextContent("2 in the trash");
    expect(trashFeature.nav?.[0]?.badge).toBe(TrashNavCount);
  });

  it("renders nothing on an error, without retrying", async () => {
    handlers.set("trash.counts", () => { throw safe("FORBIDDEN", "No access.", "FORBIDDEN"); });
    renderUi(<TrashNavCount />);
    await waitFor(() => expect(calls.filter((c) => c.path === "trash.counts")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/in the trash/)).not.toBeInTheDocument();
    expect(calls.filter((c) => c.path === "trash.counts")).toHaveLength(1);
  });
});

describe("Trash centre", () => {
  it("lists rows with due dates, blocked-restore reasons and tab counts", async () => {
    renderPage();
    await heading();
    expect(screen.getByRole("tablist", { name: "Trash sections" })).toBeInTheDocument();
    expect(screen.getAllByText("RP-2026-001 Synthetic Rollout").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Restore the customer account first.").length).toBeGreaterThan(0);
    // Each rendering (table and card) has its own description id.
    const blocked = screen.getAllByRole("button", { name: /Restore RP-2026-002/ });
    const ids = blocked.map((b) => b.getAttribute("aria-describedby"));
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of blocked) { expect(b).toBeDisabled(); expect(b).toHaveAccessibleDescription("Restore the customer account first."); }
  });

  it("shows the empty state for customers", async () => {
    const user = userEvent.setup();
    renderPage();
    await heading();
    await user.click(screen.getByRole("tab", { name: /Customers/ }));
    expect(await screen.findByRole("heading", { level: 2, name: /Customer accounts in the trash/ })).toBeInTheDocument();
    expect(await screen.findByText(/No customer accounts in the trash/i)).toBeInTheDocument();
  });

  it("keeps focus on the opener when the restore is cancelled", async () => {
    const user = userEvent.setup();
    renderPage();
    await heading();
    const opener = firstButton(/Restore RP-2026-001/);
    await user.click(opener);
    const dialog = await screen.findByRole("alertdialog", { name: /Restore RP-2026-001/ });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(opener).toHaveFocus());
    expect(calls.some((c) => c.path === "trash.restore")).toBe(false);
  });

  it("restores without step-up, announces after close and focuses the list heading", async () => {
    const user = userEvent.setup();
    const stepUp = vi.fn();
    handlers.set("trash.restore", () => ({ restored: 1, results: [{ kind: "order", publicId: row(1).publicId, ok: true }] }));
    renderPage(stepUp);
    const h = await heading();
    await user.click(firstButton(/Restore RP-2026-001/));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    await waitFor(() => expect(h).toHaveFocus());
    await waitFor(() => expect(screen.getAllByRole("status").some((el) => /restored/.test(el.textContent ?? ""))).toBe(true));
    expect(lastCall("trash.restore")).toMatchObject({ items: [{ kind: "order", publicId: row(1).publicId, batchId: row(1).batchId }] });
    expect(stepUp).not.toHaveBeenCalled();
  });

  it("requires the typed order number and sends it to the server", async () => {
    const user = userEvent.setup();
    handlers.set("trash.purge", () => ({ runIds: ["r1"], results: [{ kind: "order", publicId: row(1).publicId, ok: true, runId: "r1" }] }));
    renderPage();
    const h = await heading();
    await user.click(firstButton(/Delete permanently RP-2026-001/));
    const dialog = await screen.findByRole("alertdialog", { name: /Delete RP-2026-001 Synthetic Rollout permanently/ });
    expect(within(dialog).getByRole("heading", { name: "Erased" })).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: /Kept/ })).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Delete permanently" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), "RP-2026-001");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(h).toHaveFocus());
    expect(lastCall("trash.purge")).toMatchObject({ confirmation: "RP-2026-001", items: [{ kind: "order", publicId: row(1).publicId }] });
  });

  it("bulk deletion sends an explicit id list and DELETE <count>", async () => {
    const user = userEvent.setup();
    handlers.set("trash.purge", () => ({ runIds: [], results: [{ kind: "order", publicId: row(1).publicId, ok: true }, { kind: "order", publicId: row(2).publicId, ok: true }] }));
    renderPage();
    await heading();
    await user.click(screen.getAllByRole("checkbox", { name: "Select RP-2026-001 Synthetic Rollout" })[0]!);
    await user.click(screen.getAllByRole("checkbox", { name: "Select RP-2026-002 Synthetic Rollout" })[0]!);
    const group = screen.getByRole("group", { name: "Actions for the selected items" });
    await user.click(within(group).getByRole("button", { name: "Delete selected permanently (2)" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete 2 orders permanently?" });
    await user.type(within(dialog).getByLabelText(/to confirm/), "DELETE 2");
    await user.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(lastCall("trash.purge")).toBeDefined());
    const input = lastCall("trash.purge")!;
    expect(input.confirmation).toBe("DELETE 2");
    expect((input.items as { publicId: string }[]).map((i) => i.publicId)).toEqual([row(1).publicId, row(2).publicId]);
  });

  it("a cancelled identity check keeps the delete dialog open with an alert", async () => {
    const user = userEvent.setup();
    handlers.set("trash.purge", () => { throw stepUpRequired(); });
    renderPage();
    await heading();
    await user.click(firstButton(/Delete permanently RP-2026-001/));
    const dialog = await screen.findByRole("alertdialog", { name: /permanently/ });
    await user.type(within(dialog).getByLabelText(/to confirm/), "RP-2026-001");
    await user.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    const check = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.click(within(check).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).not.toBeInTheDocument());
    const still = screen.getByRole("alertdialog", { name: /permanently/ });
    expect(await within(still).findByRole("alert")).toHaveTextContent("Identity check cancelled. Nothing was deleted.");
  });

  it("server-side failure keeps the dialog open and returns focus to the opener after cancel", async () => {
    const user = userEvent.setup();
    handlers.set("trash.restore", () => { throw safe("RESTORE_CONFLICT", "Conflict."); });
    renderPage();
    await heading();
    const opener = firstButton(/Restore RP-2026-001/);
    await user.click(opener);
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Restore" }));
    expect(await within(dialog).findByRole("alert")).not.toBeEmptyDOMElement();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("a run stopped on unreachable copies offers finishing with step-up and the typed order number", async () => {
    const user = userEvent.setup();
    handlers.set("trash.list", () => ({ items: [row(3, { state: "failed", failureCode: "EXTERNAL_COPIES_UNREACHABLE", unreachableExternalCopies: 2, failedRunId: "01JRUNFAILED0000000000001", canRestore: false })], nextCursor: null, total: 1 }));
    handlers.set("trash.finishLeavingExternalCopies", () => ({ ok: true, runId: "01JRUNFAILED0000000000001", keptExternalCopies: 2 }));
    renderPage();
    await screen.findByRole("heading", { level: 2, name: /Orders in the trash \(1\)/ });
    expect(screen.getAllByText(/2 copies in a connected storage service could not be reached/).length).toBeGreaterThan(0);
    await user.click(firstButton(/Finish and leave 2 external copies in place/));
    const dialog = await screen.findByRole("alertdialog", { name: /leave 2 external copies in place/ });
    const confirm = within(dialog).getByRole("button", { name: "Finish and leave 2 external copies in place" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), "RP-2026-003");
    await user.click(confirm);
    await waitFor(() => expect(lastCall("trash.finishLeavingExternalCopies")).toMatchObject({ runId: "01JRUNFAILED0000000000001", confirmation: "RP-2026-003", publicId: row(3).publicId, batchId: row(3).batchId }));
    expect(lastCall("trash.finishLeavingExternalCopies")).not.toHaveProperty("targetOrderPublicId");
  });

  it("a halted customer cascade asks for the order number the run stopped on", async () => {
    const user = userEvent.setup();
    const customer = row(4, { kind: "customer", label: "RPCUS-A1B2CJJG5", reference: "RPCUS-A1B2CJJG5", ownerCustomerId: null, state: "failed", failureCode: "EXTERNAL_COPIES_UNREACHABLE", unreachableExternalCopies: 1, failedRunId: "01JRUNFAILED0000000000002", failedTargetPublicId: "01JTRASHORDER0000000000009", failedTargetReference: "RP-2026-009", canRestore: false });
    handlers.set("trash.list", (input) => ((input as { kind: string }).kind === "customer" ? { items: [customer], nextCursor: null, total: 1 } : { items: [], nextCursor: null, total: 0 }));
    handlers.set("trash.finishLeavingExternalCopies", () => ({ ok: true, runId: "01JRUNFAILED0000000000002", keptExternalCopies: 1 }));
    renderPage();
    await user.click(await screen.findByRole("tab", { name: /Customers/ }));
    await user.click(await screen.findAllByRole("button", { name: /Finish and leave 1 external copy in place/ }).then((b) => b[0]!));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("The deletion stopped on order RP-2026-009");
    await user.type(within(dialog).getByLabelText(/to confirm/), "RP-2026-009");
    await user.click(within(dialog).getByRole("button", { name: "Finish and leave 1 external copy in place" }));
    await waitFor(() => expect(lastCall("trash.finishLeavingExternalCopies")).toMatchObject({ confirmation: "RP-2026-009", targetOrderPublicId: "01JTRASHORDER0000000000009", batchId: customer.batchId }));
  });

  it("a legal hold is explained in the move dialog", async () => {
    const user = userEvent.setup();
    handlers.set("trash.moveToTrash", () => { throw safe("ORDER_ON_LEGAL_HOLD", "Release the legal hold first."); });
    renderUi(<MoveHarness />);
    await user.click(screen.getByRole("button", { name: "Move to trash" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Move to trash" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Release the legal hold first.");
  });

  pageA11y("trash centre", async () => {
    document.title = "Trash · ReadyPackets";
    renderPage();
    await heading();
    await screen.findByRole("heading", { name: "Automatic clean-up" });
  });
});

describe("Retention panel", () => {
  it("shortening retention shows the server due count and sends the reviewed values", async () => {
    const user = userEvent.setup();
    handlers.set("trash.settings.preview", () => ({ becomeDue: 3, requiresConfirmation: true, confirmationPhrase: "DELETE 3", version: 4 }));
    handlers.set("trash.settings.update", () => settings({ orderDays: 10, version: 5 }));
    renderPage();
    const days = await screen.findByLabelText(/^Orders: days in the trash/);
    await user.clear(days);
    await user.type(days, "10");
    await user.click(screen.getByRole("button", { name: "Save clean-up settings" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Shorten the retention period?" });
    expect(dialog).toHaveTextContent("3 items become due");
    await user.type(within(dialog).getByLabelText(/to confirm/), "DELETE 3");
    await user.click(within(dialog).getByRole("button", { name: "Save and confirm" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(lastCall("trash.settings.update")).toMatchObject({ orderDays: 10, expectedVersion: 4, reviewedDueCount: 3, confirmation: "DELETE 3" });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Automatic clean-up" })).toHaveFocus());
  });

  it("a changed count (409 STALE) keeps the confirmation open with Review again", async () => {
    const user = userEvent.setup();
    handlers.set("trash.settings.preview", () => ({ becomeDue: 1, requiresConfirmation: true, confirmationPhrase: "DELETE 1", version: 4 }));
    handlers.set("trash.settings.update", () => { throw safe("STALE"); });
    renderPage();
    const days = await screen.findByLabelText(/^Customer accounts: days in the trash/);
    await user.clear(days);
    await user.type(days, "5");
    await user.click(screen.getByRole("button", { name: "Save clean-up settings" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText(/to confirm/), "DELETE 1");
    await user.click(within(dialog).getByRole("button", { name: "Save and confirm" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/Review again/);
  });

  it("an invalid value focuses the field and saves nothing", async () => {
    const user = userEvent.setup();
    renderPage();
    const days = await screen.findByLabelText(/^Orders: days in the trash/);
    await user.clear(days);
    await user.type(days, "0");
    await user.click(screen.getByRole("button", { name: "Save clean-up settings" }));
    expect(days).toHaveFocus();
    expect(days).toHaveAttribute("aria-invalid", "true");
    expect(calls.some((c) => c.path.startsWith("trash.settings.preview") || c.path === "trash.settings.update")).toBe(false);
  });
});

function MoveHarness({ onMoved = () => undefined }: { onMoved?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <Button onClick={() => setOpen(true)}>Move to trash</Button>
      <MoveToTrashDialog open={open} onOpenChange={setOpen} kind="order" publicId={row(1).publicId} itemLabel="RP-2026-001 Synthetic Rollout" onMoved={onMoved} />
    </main>
  );
}

describe("MoveToTrashDialog", () => {
  function Harness({ onMoved }: { onMoved: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <main>
        <Button onClick={() => setOpen(true)}>Move to trash</Button>
        <MoveToTrashDialog open={open} onOpenChange={setOpen} kind="order" publicId={row(1).publicId} itemLabel="RP-2026-001 Synthetic Rollout" onMoved={onMoved} />
      </main>
    );
  }

  it("summarizes, sends the reason and offers Undo", async () => {
    const user = userEvent.setup();
    const onMoved = vi.fn();
    handlers.set("trash.moveToTrash", () => ({ batchId: "b1", dueAt: new Date("2026-12-27T15:00:00Z"), cascadedOrders: 0 }));
    handlers.set("trash.restore", () => ({ restored: 1, results: [{ kind: "order", publicId: row(1).publicId, ok: true }] }));
    renderUi(<Harness onMoved={onMoved} />);
    await user.click(screen.getByRole("button", { name: "Move to trash" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Move RP-2026-001 Synthetic Rollout to the trash?" });
    expect(await within(dialog).findByText(/never refunds/)).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/deleted permanently on/);
    await user.type(within(dialog).getByRole("textbox"), "Duplicate order");
    await user.click(within(dialog).getByRole("button", { name: "Move to trash" }));
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
    // The toast (and its Undo) appears once the modal has closed, so its live region is exposed.
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(lastCall("trash.moveToTrash")).toMatchObject({ kind: "order", publicId: row(1).publicId, reason: "Duplicate order" });
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(lastCall("trash.restore")).toMatchObject({ items: [{ kind: "order", publicId: row(1).publicId, batchId: "b1" }] }));
  });

  it("explains a refused move inside the dialog", async () => {
    const user = userEvent.setup();
    handlers.set("trash.moveToTrash", () => { throw safe("CUSTOMER_NOT_SUSPENDED"); });
    renderUi(<Harness onMoved={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Move to trash" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Move to trash" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Suspend this account first.");
  });
});
