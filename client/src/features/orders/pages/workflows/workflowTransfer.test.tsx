import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferPreview } from "@server/modules/orders";
import type * as trpcModule from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { fakeAuthApi, renderUi } from "@/ui/testing";
import AdminWorkflowsPage from "../AdminWorkflowsPage";
import { downloadWorkflowFile } from "./transferFiles";
import type * as transferFilesModule from "./transferFiles";

const { handlers, calls, download } = vi.hoisted(() => ({
  handlers: new Map<string, (input: unknown) => unknown>(),
  calls: [] as { path: string; input: unknown }[],
  download: vi.fn(),
}));
function proxy(path: string[]): unknown {
  const key = path.join(".");
  const run = async (input: unknown) => {
    calls.push({ path: key, input });
    const handler = handlers.get(key);
    if (!handler) throw new Error(`Unstubbed procedure: ${key}`);
    return handler(input);
  };
  const api = {
    queryOptions: (input: unknown, options?: object) => ({ queryKey: [key, input], queryFn: () => run(input), ...options }),
    mutationOptions: () => ({ mutationFn: run }),
    mutate: run,
    queryKey: () => [key],
  };
  return new Proxy(api, { get: (target, property: string) => property in target ? target[property as keyof typeof target] : proxy([...path, property]) });
}
vi.mock("@/lib/trpc", async (original) => ({ ...(await original<typeof trpcModule>()), useTRPC: () => proxy([]), useTRPCClient: () => proxy([]) }));
vi.mock("./transferFiles", async (original) => ({ ...(await original<typeof transferFilesModule>()), downloadWorkflowFile: download }));

const prefix = "orders.admin.workflows";
const transfer = `${prefix}.transfer`;
const baseStatus = { enabled: true, canExport: true, canImport: true, maxBytes: 2_097_152, maxWorkflows: 50 };
const packageText = '{"format":"readypackets.workflows","formatVersion":1}';
const fileName = "readypackets-workflows-20261122-0930.json";
const publicId = "01JTESTNEW0000000000000000";
const localPolicy = "01JTESTPOL0000000000000000";
const unsafeName = "<img src=x onerror=alert(1)> Invalid workflow";
const plan: TransferPreview = {
  digest: "a".repeat(64),
  formatVersion: 1,
  exportedAt: "2026-11-22T09:30:00Z",
  source: { release: "1.0.0", label: "Source portal" },
  blocking: [],
  workflows: [
    { key: "returns", name: "Returns", valid: true, unpublished: false, existing: { workflowPublicId: "existing", name: "Returns", hasDraft: false }, suggestedKey: "returns_2", findings: [] },
    { key: "invalid", name: unsafeName, valid: false, unpublished: true, existing: null, suggestedKey: "invalid", findings: [{ severity: "error", code: "INITIAL_REQUIRED", path: "states.0", message: "Initial state is required." }] },
    { key: "busy", name: "Pending workflow", valid: true, unpublished: false, existing: { workflowPublicId: "busy", name: "Pending workflow", hasDraft: true }, suggestedKey: "busy_2", findings: [] },
  ],
  references: {
    policies: [
      { ref: "policy_missing", title: "Old terms", slug: "old-terms", audience: "customer", usedBy: ["returns"], resolution: { status: "not_found" } },
      { ref: "skip_only", title: "Skipped terms", slug: "skipped-terms", audience: "customer", usedBy: ["invalid"], resolution: { status: "not_found" } },
      { ref: "matched", title: "Other terms", slug: "other-terms", audience: "customer", usedBy: ["returns"], resolution: { status: "matched", localPolicyPublicId: "matched-policy", title: "Current terms" } },
    ],
  },
};
const assuranceState = async () => ({ mfaEnrolled: true, recoveryCodesAcknowledged: true, totpEnrolled: true, passkeyCount: 0, recoveryCodesRemaining: 5 });
const stepUpRequired = { data: { safe: { domainCode: "STEP_UP_REQUIRED", safeMessage: "Verify first." } } };
const receipt = { importPublicId: "import-id", replayed: false, results: [
  { key: "returns", action: "create", workflowKey: "returns_2", draftPublicId: publicId },
  { key: "invalid", action: "skip", workflowKey: null, draftPublicId: null },
  { key: "busy", action: "skip", workflowKey: null, draftPublicId: null },
] };
const originalTitle = document.title;
beforeEach(() => {
  handlers.clear();
  calls.length = 0;
  download.mockReset();
  handlers.set(`${prefix}.list`, () => [{ publicId: "workflow-id", workflowKey: "standard", name: "Standard", isDefault: true, versionNumber: 1, definition: null, draftPublicId: null }]);
  handlers.set(`${prefix}.drafts.list`, () => [{ publicId: "standalone-id", name: "Standalone", workflowKey: "standalone", workflowPublicId: null, updatedAt: new Date(), errorCount: 0, warningCount: 0 }]);
  handlers.set(`${transfer}.status`, () => baseStatus);
  handlers.set(`${transfer}.export`, () => ({ fileName, packageText }));
  handlers.set(`${transfer}.preview`, () => plan);
  handlers.set(`${transfer}.applyImport`, () => receipt);
  handlers.set("compliance.policies.listPublished", () => [{ documentPublicId: localPolicy, title: "Local terms", slug: "terms", audience: "customer" }]);
});
afterEach(() => { document.title = originalTitle; vi.unstubAllGlobals(); });

function renderPage(stepUp = vi.fn().mockResolvedValue(undefined)) {
  document.title = "Workflows | ReadyPackets";
  return renderUi(<main><AdminWorkflowsPage /></main>, {
    path: "/admin/workflows", api: fakeAuthApi({ assuranceState, stepUp }),
  });
}
function requestInputs(procedure: string) { return calls.filter(({ path }) => path === `${transfer}.${procedure}`).map(({ input }) => input); }
function upload() { return userEvent.setup().upload(screen.getByLabelText(/Workflow package/), new File([packageText], fileName, { type: "application/json" })); }
async function open(keyboard = false) {
  const opener = await screen.findByRole("button", { name: "Import workflows" });
  if (keyboard) { opener.focus(); await userEvent.keyboard("{Enter}"); }
  else await userEvent.click(opener);
  await screen.findByRole("dialog", { name: "Import workflows" });
  return opener;
}
async function review() {
  await upload();
  await userEvent.click(screen.getByRole("button", { name: "Preview package" }));
  await screen.findByRole("heading", { name: "Review import plan" });
}
async function choices(policy: "remove" | "map" = "map", action: "create" | "draft" = "create") {
  await userEvent.selectOptions(screen.getByRole("combobox", { name: /^Action for.*Returns/ }), action);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Action for Pending workflow" }), "skip");
  await userEvent.selectOptions(await screen.findByRole("combobox", { name: /^Map Old terms/ }), policy === "map" ? localPolicy : "remove-gate");
}
async function confirm() {
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  return screen.findByRole("heading", { name: "Confirm draft import" });
}
async function verifiedApply() {
  await userEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
  await userEvent.click(screen.getByRole("button", { name: "Import drafts" }));
}
async function finishStepUp() {
  const modal = await screen.findByRole("dialog", { name: "Confirm it's you" });
  fireEvent.change(within(modal).getByLabelText(/Password/), { target: { value: "fixture" } });
  fireEvent.change(within(modal).getByLabelText(/6-digit code/), { target: { value: "123456" } });
  await userEvent.click(within(modal).getByRole("button", { name: "Verify" }));
}

describe("workflow transfer", () => {
  it("exports a single row, selects a standalone draft and published workflow, and exports all", async () => {
    renderPage();
    const standard = await screen.findByRole("button", { name: "Export Standard" });
    const selected = screen.getByRole("button", { name: "Export selected" });
    expect(selected).toBeDisabled();
    await userEvent.click(standard);
    await waitFor(() => expect(downloadWorkflowFile).toHaveBeenCalledWith(fileName, packageText));
    expect(requestInputs("export")).toEqual([{ selection: { workflowKeys: ["standard"] } }]);
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Standard" }));
    // DataTable renders desktop and mobile markup; styles hide the inactive copy in a browser.
    await userEvent.click(within(screen.getByRole("table", { name: "Drafts" })).getByRole("checkbox", { name: "Select Standalone" }));
    expect(screen.getByText("2 workflows selected")).toHaveAttribute("role", "status");
    await userEvent.click(selected);
    await userEvent.click(screen.getByRole("button", { name: "Export all" }));
    expect(requestInputs("export")).toEqual([
      { selection: { workflowKeys: ["standard"] } },
      { selection: { workflowKeys: ["standard", "standalone"] } },
      { selection: { all: true } },
    ]);
    expect(downloadWorkflowFile).toHaveBeenCalledTimes(3);
  });

  it.each([{ enabled: false }, { canExport: false, canImport: false }])("hides transfer controls when status is %j", async (changes) => {
    handlers.set(`${transfer}.status`, () => ({ ...baseStatus, ...changes }));
    renderPage();
    await screen.findByRole("button", { name: "New workflow" });
    await waitFor(() => expect(requestInputs("status")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Import workflows" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export selected" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export Standard" })).not.toBeInTheDocument();
  });

  it("D10: when off, an admin turns it on from the page with a labelled switch; turning off asks first", async () => {
    let enabled = false;
    handlers.set(`${transfer}.status`, () => ({ ...baseStatus, enabled, canToggle: true }));
    handlers.set(`${transfer}.setEnabled`, (input) => {
      enabled = (input as { enabled: boolean }).enabled;
      return { enabled, changed: true };
    });
    renderPage();
    const toggle = await screen.findByRole("switch", { name: "Workflow export and import" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAccessibleDescription(/Off\. Turn it on/);
    expect(screen.queryByRole("button", { name: "Import workflows" })).not.toBeInTheDocument();
    toggle.focus();
    await userEvent.keyboard(" ");
    await waitFor(() => expect(requestInputs("setEnabled")).toEqual([{ enabled: true }]));
    await screen.findByRole("button", { name: "Export selected" });
    expect(screen.getByRole("switch", { name: "Workflow export and import" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("switch", { name: "Workflow export and import" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Turn off workflow export and import/ }).catch(() => screen.findByRole("dialog", { name: /Turn off workflow export and import/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(requestInputs("setEnabled")).toHaveLength(1);
  });

  it("D10: the switch is absent without canToggle and a refused save is announced", async () => {
    handlers.set(`${transfer}.status`, () => ({ ...baseStatus, enabled: false, canToggle: false }));
    const view = renderPage();
    await screen.findByRole("button", { name: "New workflow" });
    await waitFor(() => expect(requestInputs("status")).toHaveLength(1));
    expect(screen.queryByRole("switch", { name: "Workflow export and import" })).not.toBeInTheDocument();
    view.unmount();
    handlers.set(`${transfer}.status`, () => ({ ...baseStatus, enabled: false, canToggle: true }));
    handlers.set(`${transfer}.setEnabled`, () => { throw { data: { safe: { domainCode: "ACTOR_NOT_AUTHORIZED", safeMessage: "You do not have permission to perform this action." } } }; });
    renderPage();
    await userEvent.click(await screen.findByRole("switch", { name: "Workflow export and import" }));
    expect(await screen.findByText("You do not have permission to perform this action.")).toBeInTheDocument();
  });

  it("rejects non-JSON and oversize files locally and stops on a rejected server digest", async () => {
    handlers.set(`${transfer}.preview`, () => ({ ...plan, blocking: [{ code: "DIGEST_MISMATCH", message: "The integrity digest does not match." }] }));
    renderPage();
    await open();
    const input = screen.getByLabelText(/Workflow package/);
    await userEvent.setup({ applyAccept: false }).upload(input, new File(["x"], "unrelated.txt", { type: "text/plain" }));
    expect(input).toHaveAccessibleDescription(/\.json file extension/);
    await userEvent.upload(input, new File([new Uint8Array(2_097_153)], fileName, { type: "application/json" }));
    expect(input).toHaveAccessibleDescription(/2 MB or smaller/);
    await userEvent.click(screen.getByRole("button", { name: "Preview package" }));
    expect(requestInputs("preview")).toEqual([]);
    await review();
    expect(screen.getByText("The integrity digest does not match.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(requestInputs("applyImport")).toEqual([]);
  });

  it("uses keyboard launch, moves focus between steps, requires policy mapping and returns focus on Escape at 320px", async () => {
    const w = vi.spyOn(window, "innerWidth", "get").mockReturnValue(320);
    try {
      renderPage();
      const opener = await open(true);
      expect(screen.getByLabelText(/Workflow package/)).toHaveFocus();
      await upload();
      const next = screen.getByRole("button", { name: "Preview package" });
      next.focus();
      await userEvent.keyboard("{Enter}");
      expect(await screen.findByRole("heading", { name: "Review import plan" })).toHaveFocus();
      expect(screen.getByRole("group", { name: /^<img src=x/ })).toBeVisible();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      expect(screen.getByText("Initial state is required.")).toBeVisible();
      expect(screen.getByRole("combobox", { name: /Action for.*Invalid workflow/ })).toBeDisabled();
      expect(within(screen.getByRole("combobox", { name: "Action for Pending workflow" })).getByRole("option", { name: /^Add as/ })).toBeDisabled();
      const firstAction = screen.getByRole("combobox", { name: /^Action for.*Returns/ });
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(firstAction).toHaveFocus();
      expect(firstAction).toHaveAccessibleDescription("Choose an action for this workflow.");
      await userEvent.selectOptions(firstAction, "draft");
      await userEvent.selectOptions(screen.getByRole("combobox", { name: "Action for Pending workflow" }), "skip");
      expect(screen.queryByRole("combobox", { name: /Skipped terms/ })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(screen.getByText(/Resolve every missing policy/)).toBeVisible();
      const mapping = screen.getByRole("combobox", { name: /^Map Old terms/ });
      expect(mapping).toHaveFocus();
      expect(mapping).toHaveAccessibleDescription("Choose a local policy or remove this gate.");
      await userEvent.selectOptions(mapping, "remove-gate");
      await userEvent.tab();
      expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
      await userEvent.tab();
      await userEvent.tab();
      await userEvent.keyboard("{Enter}");
      expect(await screen.findByRole("heading", { name: "Confirm draft import" })).toHaveFocus();
      expect(screen.getByText(/Old terms: Remove the gate/)).toBeVisible();
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(opener).toHaveFocus());
      expect(requestInputs("applyImport")).toEqual([]);
    } finally { w.mockRestore(); }
  });

  it("steps up, reuses the exact request after an ambiguous response, refreshes lists and links to the draft", async () => {
    const stepUp = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;
    handlers.set(`${transfer}.applyImport`, () => {
      attempts++;
      if (attempts === 1) throw stepUpRequired;
      if (attempts === 2) throw new Error("No response");
      return { ...receipt, replayed: true };
    });
    renderPage(stepUp);
    const opener = await open();
    await review();
    expect(requestInputs("preview")).toEqual([{ packageText }]);
    await choices();
    await confirm();
    await userEvent.click(screen.getByRole("button", { name: "Import drafts" }));
    expect(screen.getByText(/Confirm that you understand/)).toBeVisible();
    expect(requestInputs("applyImport")).toEqual([]);
    await verifiedApply();
    await finishStepUp();
    await screen.findByText(/result could not be confirmed/);
    await userEvent.click(screen.getByRole("button", { name: "Retry same import" }));
    expect(await screen.findByRole("heading", { name: "Import result" })).toHaveFocus();
    expect(screen.getByRole("link", { name: "Review draft: returns_2" })).toHaveAttribute("href", `/admin/workflows/drafts/${publicId}`);
    expect(screen.getByText(/No duplicate drafts/)).toBeVisible();
    const inputs = requestInputs("applyImport");
    expect(inputs).toHaveLength(3);
    expect(inputs[0]).toEqual({
      packageText, idempotencyKey: expect.stringMatching(/^k[a-f0-9]{36}$/u),
      decisions: [{ key: "returns", action: "create" }, { key: "invalid", action: "skip" }, { key: "busy", action: "skip" }],
      policyMappings: [{ ref: "policy_missing", localPolicyPublicId: localPolicy }],
    });
    expect(inputs[1]).toEqual(inputs[0]);
    expect(inputs[2]).toEqual(inputs[0]);
    expect(stepUp).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(calls.filter(({ path }) => path === `${prefix}.drafts.list`)).toHaveLength(2));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("cancels preview step-up without previewing or applying again", async () => {
    handlers.set(`${transfer}.preview`, () => { throw stepUpRequired; });
    renderPage();
    await open();
    await upload();
    await userEvent.click(screen.getByRole("button", { name: "Preview package" }));
    const modal = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await userEvent.click(within(modal).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText(/Verification was cancelled/)).toBeVisible();
    expect(requestInputs("preview")).toHaveLength(1);
    expect(requestInputs("applyImport")).toEqual([]);
  });

  it("returns keyboard focus to the review after successful preview verification", async () => {
    let attempts = 0;
    handlers.set(`${transfer}.preview`, () => {
      if (!attempts++) throw stepUpRequired;
      return plan;
    });
    renderPage();
    await open();
    await upload();
    await userEvent.click(screen.getByRole("button", { name: "Preview package" }));
    await finishStepUp();
    const heading = await screen.findByRole("heading", { name: "Review import plan" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(requestInputs("preview")).toEqual([{ packageText }, { packageText }]);
  });

  it("submits explicit gate removal and adds the draft to the matching workflow", async () => {
    handlers.set(`${transfer}.applyImport`, () => ({
      ...receipt,
      results: [{ key: "returns", action: "draft", workflowKey: "returns", draftPublicId: publicId }],
    }));
    renderPage();
    await open();
    await review();
    await choices("remove", "draft");
    await confirm();
    expect(screen.getByText(/Old terms: Remove the gate/)).toBeVisible();
    await verifiedApply();
    expect(await screen.findByRole("link", { name: "Review draft: returns" })).toHaveAttribute("href", `/admin/workflows/drafts/${publicId}`);
    expect(requestInputs("applyImport")).toEqual([{
      packageText, idempotencyKey: expect.any(String),
      decisions: [{ key: "returns", action: "draft" }, { key: "invalid", action: "skip" }, { key: "busy", action: "skip" }],
      policyMappings: [{ ref: "policy_missing", removeGates: true }],
    }]);
  });

  pageA11y("Workflow export controls", async () => {
    renderPage();
    await screen.findByRole("button", { name: "Export all" });
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Standard" }));
  });
  pageA11y("Workflow import file", async () => { renderPage(); await open(); });
  pageA11y("Workflow import review and policy mapping", async () => { renderPage(); await open(); await review(); await choices(); });
  pageA11y("Workflow import confirmation", async () => { renderPage(); await open(); await review(); await choices("remove"); await confirm(); });
  pageA11y("Workflow import step-up", async () => {
    handlers.set(`${transfer}.applyImport`, () => { throw stepUpRequired; });
    renderPage();
    await open();
    await review();
    await choices();
    await confirm();
    await verifiedApply();
    await screen.findByRole("dialog", { name: "Confirm it's you" });
  });
});
