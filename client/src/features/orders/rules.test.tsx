/** Increment 04 — order-page rules (phases, checklist, acknowledgement, unlock), console order tools, designer rule helpers. */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "wouter";
import type * as trpcModule from "@/lib/trpc";
import type * as featuresModule from "@/lib/features";
import { pageA11y } from "@/test/a11y";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import CustomerOrdersTab, { AccessDialog, NewOrderForCustomerDialog } from "./ConsoleOrderTools";
import NewOrderPage from "./pages/NewOrderPage";
import OrderDetailPage from "./pages/OrderDetailPage";
import AdminOrderDetailPage from "./pages/AdminOrderDetailPage";
import { addPhase, ACTORS, parseTypes, removePhase, updatePhase, updateState, withRequirements, WIZARD_STEPS, stepOfIssue, type DraftDefinition } from "./pages/workflows/model";
import { ordersFeature } from "./routes";

const { handlers, calls, session, flags } = vi.hoisted(() => ({
  handlers: new Map<string, (input: unknown) => unknown>(),
  calls: [] as { path: string; input: unknown }[],
  session: { role: "customer" as string },
  flags: new Set<string>(),
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
    infiniteQueryOptions: (input: unknown, opts: Record<string, unknown> = {}) => ({
      queryKey: [key, input, "infinite"],
      queryFn: ({ pageParam }: { pageParam: unknown }) => run({ ...(input as object), cursor: pageParam ?? undefined }),
      initialPageParam: null,
      ...opts,
    }),
    mutationOptions: (opts: Record<string, unknown> = {}) => ({ mutationFn: run, ...opts }),
    mutate: run,
    query: run,
    queryKey: (input?: unknown) => [key, input],
    pathKey: () => [key],
  };
  return new Proxy(api, { get: (target, prop: string) => (prop in target ? target[prop as keyof typeof target] : proxy([...path, prop])) });
}

vi.mock("@/lib/trpc", async (original) => ({ ...(await original<typeof trpcModule>()), useTRPC: () => proxy([]), useTRPCClient: () => proxy([]) }));
vi.mock("@/lib/features", async (original) => ({ ...(await original<typeof featuresModule>()), useFeatureEnabled: (flag: string) => flags.has(flag) }));
vi.mock("@/lib/session", () => ({ useSession: () => ({ me: { state: "full", user: { role: session.role } }, view: { status: "full", role: session.role } }) }));
vi.mock("@/app/registry", () => ({ ORDER_TABS: [], FEATURES: [] }));

const ORDER_ID = "01JTESTORDER0000000000000A";
const CUSTOMER_ID = "01JTESTUSER00000000000000B";
const now = new Date("2026-11-20T09:00:00.000Z");
const HASH = "a".repeat(64);
const detail = {
  publicId: ORDER_ID,
  reference: "RP-2026-000001",
  projectName: "Synthetic project",
  statusKey: "intake",
  statusLabel: "Intake",
  statusTone: "info",
  statusKind: "initial",
  lockState: "none",
  totalMinor: 2500,
  subtotalMinor: 2500,
  discountMinor: 0,
  discountLabel: null,
  currency: "USD",
  accessRole: "owner",
  origin: "portal",
  version: 3,
  canWrite: true,
  canShare: false,
  ownerPublicId: "01JTESTUSER00000000000000A",
  createdAt: now,
  updatedAt: now,
  submittedAt: now,
  lineItems: [],
  notes: [],
  history: [],
  transitions: [{ to: "review", label: "Review", actionLabel: "Send for review", destructive: false, requiresNote: false }],
};
const rules = (overrides: Record<string, unknown> = {}) => ({
  phases: [
    { key: "intake", label: "Intake", position: "current", locked: false, lockedAt: null },
    { key: "delivery", label: "Delivery", position: "upcoming", locked: false, lockedAt: null },
  ],
  status: { key: "intake", label: "Intake", phaseKey: "intake" },
  uploads: [{ key: "contract", label: "Signed contract", hint: "Synthetic hint", kind: "document", minCount: 1, maxCount: 2, allowedTypes: ["pdf"], uploadedBy: ["customer"], count: 0, met: false, canUpload: true }],
  acknowledgements: [{ key: "terms", title: "Synthetic terms", body: "Line one of the synthetic terms.\n\nLine two.", acceptedBy: "customer", requireTypedName: true, textSha256: HASH, met: false, acceptedAt: null, canAccept: true }],
  unmet: 2,
  readOnly: false,
  readOnlyReason: null,
  canUnlock: false,
  acceptancePending: false,
  ...overrides,
});

function renderCustomerOrder() {
  return renderUi(
    <main>
      <Route path="/orders/:orderId">
        <OrderDetailPage />
      </Route>
    </main>,
    { path: `/orders/${ORDER_ID}` },
  );
}

beforeEach(() => {
  handlers.clear();
  calls.length = 0;
  flags.clear();
  session.role = "customer";
  handlers.set("orders.get", () => detail);
  handlers.set("orders.requirements.forOrder", () => rules());
  handlers.set("orders.sharing.list", () => ({ grants: [], invites: [] }));
});

describe("order page rules", () => {
  it("shows the phase rail and a checklist with upload and acceptance actions", async () => {
    const { container } = renderCustomerOrder();
    const rail = await screen.findByRole("list", { name: /Order phases/ });
    expect(within(rail).getByText("Intake")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Needed before the next step (Intake)" })).toBeInTheDocument();
    expect(screen.getByText("0 of 2 done")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Upload Signed contract" })).toHaveAttribute("href", `/orders/${ORDER_ID}/files?slot=contract`);
    expect(screen.getByRole("button", { name: "Read and accept: Synthetic terms" })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("an unmet acceptance gate disables Upload and Read and accept with an explanation", async () => {
    handlers.set("orders.requirements.forOrder", () => rules({ acceptancePending: true }));
    const { container } = renderCustomerOrder();
    const upload = await screen.findByRole("button", { name: "Upload Signed contract" });
    const accept = screen.getByRole("button", { name: "Read and accept: Synthetic terms" });
    expect(upload).toBeDisabled();
    expect(accept).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Upload Signed contract" })).not.toBeInTheDocument();
    expect(upload).toHaveAccessibleDescription("Uploads and acknowledgements are paused until you accept the policy shown above.");
    expect(accept).toHaveAccessibleDescription("Uploads and acknowledgements are paused until you accept the policy shown above.");
    await expectNoAxeViolations(container);
  });

  it("a slot hint ending in punctuation is not doubled when joined (no \"..\")", async () => {
    const base = rules();
    handlers.set("orders.requirements.forOrder", () => rules({ uploads: [{ ...base.uploads[0]!, hint: "Upload the signed files." }] }));
    renderCustomerOrder();
    const text = await screen.findByText(/^Upload the signed files\. /);
    expect(text.textContent).not.toContain("..");
  });

  it("renders nothing for a workflow without phases or requirements", async () => {
    handlers.set("orders.requirements.forOrder", () => rules({ phases: [], uploads: [], acknowledgements: [], unmet: 0 }));
    renderCustomerOrder();
    await screen.findByRole("heading", { level: 1, name: "Synthetic project" });
    await waitFor(() => expect(calls.some((c) => c.path === "orders.requirements.forOrder")).toBe(true));
    expect(screen.queryByRole("list", { name: /Order phases/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Needed before the next step/)).not.toBeInTheDocument();
  });

  it("acknowledgement needs the checkbox and a typed name, then sends the hash it was shown", async () => {
    handlers.set("orders.requirements.acknowledge", () => ({ acceptedAt: now.toISOString() }));
    const user = userEvent.setup();
    renderCustomerOrder();
    await user.click(await screen.findByRole("button", { name: "Read and accept: Synthetic terms" }));
    const dialog = await screen.findByRole("dialog", { name: "Synthetic terms" });
    const region = within(dialog).getByRole("region", { name: "Full text: Synthetic terms" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.textContent).toContain("Line two.");
    await user.click(within(dialog).getByRole("button", { name: "Accept" }));
    expect(await within(dialog).findByText(/Tick the box/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox", { name: /I have read and accept this text/ }));
    await user.click(within(dialog).getByRole("button", { name: "Accept" }));
    expect(await within(dialog).findByText("Type your full name to confirm.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "orders.requirements.acknowledge")).toBe(false);
    await user.type(within(dialog).getByLabelText(/Type your full name/), "Synthetic Person");
    await user.click(within(dialog).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.find((c) => c.path === "orders.requirements.acknowledge")?.input).toEqual({ orderId: ORDER_ID, statusKey: "intake", ackKey: "terms", textSha256: HASH, typedName: "Synthetic Person" });
  });

  it("shows server refusals such as a changed text inside the dialog", async () => {
    handlers.set("orders.requirements.forOrder", () => rules({ acknowledgements: [{ ...rules().acknowledgements[0], requireTypedName: false }] }));
    handlers.set("orders.requirements.acknowledge", () => {
      throw new Error("The text changed since you opened it. Read it again.");
    });
    const user = userEvent.setup();
    renderCustomerOrder();
    await user.click(await screen.findByRole("button", { name: "Read and accept: Synthetic terms" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText(/Type your full name/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: "Accept" }));
    expect(await within(dialog).findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "orders.requirements.acknowledge")?.input).not.toHaveProperty("typedName");
  });

  it("staff unlock dialog needs a reason of 10+ characters and sends the notify choice", async () => {
    session.role = "staff";
    handlers.set("orders.admin.get", () => ({ ...detail, accessRole: "staff", transitions: [] }));
    handlers.set("orders.admin.referenceHistory", () => []);
    handlers.set("orders.requirements.forOrder", () =>
      rules({ canUnlock: true, phases: [{ key: "intake", label: "Intake", position: "done", locked: true, lockedAt: now.toISOString() }, { key: "delivery", label: "Delivery", position: "current", locked: false, lockedAt: null }] }),
    );
    handlers.set("orders.phases.unlock", () => ({ ok: true }));
    const user = userEvent.setup();
    // Part B: in the console the rules panel lives on the Phases tab.
    renderUi(
      <Route path="/admin/orders/:orderId/:tab">
        <AdminOrderDetailPage />
      </Route>,
      { path: `/admin/orders/${ORDER_ID}/phases` },
    );
    expect(await screen.findByText("Locked")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Unlock a phase" }));
    const dialog = await screen.findByRole("dialog", { name: "Unlock a phase" });
    await expectNoAxeViolations(dialog);
    await user.type(within(dialog).getByLabelText(/Reason/), "short");
    await user.click(within(dialog).getByRole("button", { name: "Unlock" }));
    expect(await within(dialog).findByText(/at least 10 characters/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Reason/), " but now long enough");
    await user.click(within(dialog).getByRole("switch", { name: "Notify the customer" }));
    await user.click(within(dialog).getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.find((c) => c.path === "orders.phases.unlock")?.input).toEqual({ orderId: ORDER_ID, phaseKey: "intake", reason: "short but now long enough", notifyCustomer: false });
  });
});

describe("customer tasks (increment 06, D8)", () => {
  const DOC_SHA = "b".repeat(64);
  const contractDoc = { key: "contract", label: "Contract", hint: "Review and sign.", required: true, responseModes: ["upload_reply", "acknowledge"], allowedTypes: ["docx"], replySlotKey: "contract_reply", sourceCount: 1, replyCount: 0, acknowledged: false, textSha256: DOC_SHA, met: false, waived: false, canStaffUpload: false, canReply: true, canEdit: false, canAcknowledge: true };
  const tasks = (overrides: Record<string, unknown> = {}) =>
    rules({
      uploads: [{ key: "voice", label: "Voice note", hint: null, kind: "audio", minCount: 1, maxCount: 1, allowedTypes: ["mp3"], uploadedBy: ["customer"], count: 0, met: false, canUpload: true, waived: false, taskKind: "record", capture: "record", maxMinutes: 5 }],
      acknowledgements: [{ key: "brief_note", title: "Your brief", body: "Please confirm the brief.", acceptedBy: "customer", requireTypedName: false, source: "order_note", textSha256: HASH, met: false, acceptedAt: null, canAccept: true, waived: false, orderNote: "Synthetic note: two pages.", canEditNote: false }],
      documents: [contractDoc],
      canWaive: false,
      agreementPending: null,
      ...overrides,
    }) as ReturnType<typeof rules> & { documents: (typeof contractDoc)[] };
  const renderConsole = () =>
    renderUi(
      <Route path="/admin/orders/:orderId/:tab">
        <AdminOrderDetailPage />
      </Route>,
      { path: `/admin/orders/${ORDER_ID}/phases` },
    );
  const asStaff = () => {
    session.role = "staff";
    handlers.set("orders.admin.get", () => ({ ...detail, accessRole: "staff", transitions: [] }));
    handlers.set("orders.admin.referenceHistory", () => []);
  };

  it("customer: record link opens the recorder, document links go to the right slot, note shows in the dialog", async () => {
    handlers.set("orders.requirements.forOrder", () => tasks());
    handlers.set("orders.requirements.acknowledge", () => ({ acknowledgementId: "x" }));
    const user = userEvent.setup();
    renderCustomerOrder();
    const record = await screen.findByRole("link", { name: "Record Voice note" });
    expect(record).toHaveAttribute("href", `/orders/${ORDER_ID}/files?slot=voice&mode=record`);
    expect(screen.getByText(/Record in the portal \(up to 5 minutes\)/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Upload reply: Contract" })).toHaveAttribute("href", `/orders/${ORDER_ID}/files?slot=contract_reply`);
    expect(screen.getByRole("link", { name: "View document: Contract" })).toHaveAttribute("href", `/orders/${ORDER_ID}/files?slot=contract`);
    await user.click(screen.getByRole("button", { name: "Read and accept: Your brief" }));
    const dialog = await screen.findByRole("dialog", { name: "Your brief" });
    expect(within(dialog).getByRole("region", { name: "Full text: Your brief" }).textContent).toContain("Synthetic note: two pages.");
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(calls.find((c) => c.path === "orders.requirements.acknowledge")?.input).toEqual({ orderId: ORDER_ID, statusKey: "intake", ackKey: "brief_note", textSha256: HASH }));
  });

  it("customer: acknowledging a document sends its hash; waiting states are described in words", async () => {
    handlers.set("orders.requirements.forOrder", () => tasks());
    handlers.set("orders.requirements.acknowledge", () => ({ acknowledgementId: "x" }));
    const user = userEvent.setup();
    renderCustomerOrder();
    await user.click(await screen.findByRole("button", { name: "Acknowledge: Contract" }));
    const dialog = await screen.findByRole("dialog", { name: "Contract" });
    expect(within(dialog).getByRole("link", { name: /Open the document/ })).toHaveAttribute("href", `/orders/${ORDER_ID}/files?slot=contract`);
    await user.click(within(dialog).getByRole("checkbox", { name: /I have read this document/ }));
    await user.click(within(dialog).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(calls.find((c) => c.path === "orders.requirements.acknowledge")?.input).toEqual({ orderId: ORDER_ID, statusKey: "intake", ackKey: "contract", textSha256: DOC_SHA }));
  });

  it("customer: not-yet-shared document and missing note are explained, with no action", async () => {
    const base = tasks();
    handlers.set("orders.requirements.forOrder", () =>
      tasks({
        acknowledgements: [{ ...base.acknowledgements[0], orderNote: null, canAccept: false }],
        documents: [{ ...base.documents[0], sourceCount: 0, canReply: false, canAcknowledge: false }],
      }),
    );
    renderCustomerOrder();
    expect(await screen.findByText("Our team is preparing this note")).toBeInTheDocument();
    expect(screen.getByText("Our team is preparing this document")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Acknowledge: Contract" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Read and accept: Your brief/ })).not.toBeInTheDocument();
  });

  it("customer: a pending agreement pauses tasks and offers the agreement", async () => {
    handlers.set("orders.requirements.forOrder", () => tasks({ agreementPending: { policyPublicId: "01JTESTPOL0000000000000000", signatureMode: "checkbox" } }));
    renderCustomerOrder();
    expect(await screen.findByText("Your tasks are paused until you accept the agreement.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record Voice note" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review and accept the agreement" })).toBeInTheDocument();
  });

  it("console: staff write the order note and waive a task with a reason", async () => {
    asStaff();
    const base = tasks();
    handlers.set("orders.requirements.forOrder", () =>
      tasks({ canWaive: true, acknowledgements: [{ ...base.acknowledgements[0], orderNote: null, canAccept: false, canEditNote: true }], documents: [{ ...base.documents[0], canStaffUpload: true, canReply: false, canAcknowledge: false }] }),
    );
    handlers.set("orders.requirements.setTaskNote", () => ({ notePublicId: "n", version: 1, textSha256: HASH }));
    handlers.set("orders.requirements.waive", () => ({ waiverId: "w", waivedAt: now.toISOString() }));
    const user = userEvent.setup();
    renderConsole();
    expect(await screen.findByRole("link", { name: "Manage document: Contract" })).toHaveAttribute("href", `/admin/orders/${ORDER_ID}/files?slot=contract`);
    await user.click(screen.getByRole("button", { name: "Write note: Your brief" }));
    const noteDialog = await screen.findByRole("dialog", { name: /Note for the customer/ });
    await user.click(within(noteDialog).getByRole("button", { name: "Save note" }));
    expect(await within(noteDialog).findByText("Write the note the customer must read.")).toBeInTheDocument();
    expect(within(noteDialog).getByLabelText(/^Note/)).toHaveAccessibleDescription(/Write the note the customer must read/);
    await user.type(within(noteDialog).getByLabelText(/^Note/), "Synthetic brief text.");
    await user.click(within(noteDialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.find((c) => c.path === "orders.requirements.setTaskNote")?.input).toEqual({ orderId: ORDER_ID, statusKey: "intake", ackKey: "brief_note", body: "Synthetic brief text." });
    await user.click(screen.getByRole("button", { name: "Waive Voice note" }));
    const waive = await screen.findByRole("dialog", { name: /Waive “Voice note”/ });
    await expectNoAxeViolations(waive);
    await user.type(within(waive).getByLabelText(/Reason/), "short");
    await user.click(within(waive).getByRole("button", { name: "Waive task" }));
    expect(await within(waive).findByText(/at least 10 characters/)).toBeInTheDocument();
    await user.type(within(waive).getByLabelText(/Reason/), " but sent by post");
    await user.click(within(waive).getByRole("button", { name: "Waive task" }));
    await waitFor(() => expect(calls.find((c) => c.path === "orders.requirements.waive")?.input).toEqual({ orderId: ORDER_ID, statusKey: "intake", taskKey: "voice", reason: "short but sent by post" }));
  });

  it("waived tasks read as done and offer no actions", async () => {
    const base = tasks();
    handlers.set("orders.requirements.forOrder", () => tasks({ uploads: [{ ...base.uploads[0], waived: true, met: true }] }));
    renderCustomerOrder();
    expect(await screen.findByText("Waived by our team")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Record Voice note" })).not.toBeInTheDocument();
  });
});

describe("console order tools", () => {
  const catalog = [
    {
      publicId: "01JTESTGROUP000000000000A",
      name: "Synthetic group",
      products: [{ publicId: "01JTESTPROD000000000000A1", name: "Synthetic A", priceMinor: 1000, currency: "USD" }],
    },
  ];
  const lookup = () => [{ publicId: CUSTOMER_ID, name: "Synthetic Customer B", customerRef: "C-1", emailMasked: "s***@example.test" }];

  it("new order for a customer: pick a customer, set quantities, submit once", async () => {
    session.role = "staff";
    handlers.set("orders.catalog.list", () => catalog);
    handlers.set("orders.admin.customerLookup", lookup);
    handlers.set("orders.admin.createForCustomer", () => ({ publicId: ORDER_ID, reference: "RP-2026-000002" }));
    const user = userEvent.setup();
    const { location } = renderUi(<NewOrderForCustomerDialog open onClose={() => undefined} />, { path: "/admin/orders" });
    const dialog = await screen.findByRole("dialog", { name: "New order for a customer" });
    await user.click(within(dialog).getByRole("button", { name: "Create order" }));
    expect(await within(dialog).findByText("Choose a customer.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Find customer/), "Syn");
    await user.click(await within(dialog).findByRole("radio", { name: /Synthetic Customer B/ }));
    await user.type(within(dialog).getByLabelText(/Project name/), "Synthetic console order");
    await user.type(within(dialog).getByLabelText("Quantity of Synthetic A"), "2");
    await expectNoAxeViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Create order" }));
    await waitFor(() => expect(location.history?.at(-1)).toBe(`/admin/orders/${ORDER_ID}`));
    const sent = calls.filter((c) => c.path === "orders.admin.createForCustomer");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input).toMatchObject({ customerPublicId: CUSTOMER_ID, projectName: "Synthetic console order", items: [{ productPublicId: "01JTESTPROD000000000000A1", quantity: 2 }] });
    expect((sent[0]!.input as { idempotencyKey: string }).idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,80}$/);
  });

  it("access dialog lists grants; admins grant and revoke, staff only view", async () => {
    session.role = "admin";
    handlers.set("orders.admin.access.list", () => ({
      items: [{ grantId: "01JTESTGRANT000000000000A", scope: "customer", role: "viewer", status: "active", granteeName: "Synthetic Viewer", granteeEmailMasked: "v***@example.test", grantedAt: now.toISOString() }],
    }));
    handlers.set("orders.admin.access.grant", () => ({ grantId: "01JTESTGRANT000000000000B" }));
    handlers.set("orders.admin.access.revoke", () => ({ ok: true }));
    const user = userEvent.setup();
    const { unmount } = renderUi(<AccessDialog open onClose={() => undefined} scope={{ customerPublicId: CUSTOMER_ID }} subject="Synthetic Customer B" />);
    const dialog = await screen.findByRole("dialog", { name: "Access to all orders of Synthetic Customer B" });
    expect((await within(dialog).findAllByText("Synthetic Viewer")).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("All orders").length).toBeGreaterThan(0);
    await expectNoAxeViolations(dialog);
    await user.type(within(dialog).getByLabelText(/Email of an existing platform user/), "someone@example.test");
    await user.selectOptions(within(dialog).getByLabelText(/Role/), "contributor");
    await user.click(within(dialog).getByRole("button", { name: "Grant access" }));
    await waitFor(() => expect(calls.some((c) => c.path === "orders.admin.access.grant")).toBe(true));
    expect(calls.find((c) => c.path === "orders.admin.access.grant")?.input).toEqual({ scope: { customerPublicId: CUSTOMER_ID }, email: "someone@example.test", role: "contributor" });
    await user.click(within(dialog).getAllByRole("button", { name: "Revoke access for Synthetic Viewer" })[0]!);
    await waitFor(() => expect(calls.find((c) => c.path === "orders.admin.access.revoke")?.input).toEqual({ grantId: "01JTESTGRANT000000000000A" }));
    unmount();

    session.role = "staff";
    renderUi(<AccessDialog open onClose={() => undefined} scope={{ orderId: ORDER_ID }} subject="RP-2026-000001" />);
    const view = await screen.findByRole("dialog", { name: "Access to order RP-2026-000001" });
    expect((await within(view).findAllByText("Synthetic Viewer")).length).toBeGreaterThan(0);
    expect(within(view).queryByRole("button", { name: /Revoke/ })).not.toBeInTheDocument();
    expect(within(view).queryByRole("button", { name: "Grant access" })).not.toBeInTheDocument();
  });

  it("customer tab is contributed for staff and lists that customer's orders", async () => {
    session.role = "staff";
    handlers.set("orders.admin.list", () => ({ items: [{ publicId: ORDER_ID, reference: "RP-2026-000001", projectName: "Synthetic project", statusLabel: "Intake", updatedAt: now }], nextCursor: null }));
    expect(ordersFeature.customerTabs?.map((tab) => [tab.key, tab.access])).toEqual([["orders", "staff"]]);
    renderUi(<CustomerOrdersTab customerId={CUSTOMER_ID} />);
    expect((await screen.findAllByRole("link", { name: "RP-2026-000001" }))[0]).toHaveAttribute("href", `/admin/orders/${ORDER_ID}`);
    expect(calls.find((c) => c.path === "orders.admin.list")?.input).toMatchObject({ customerPublicId: CUSTOMER_ID });
    expect(screen.getByRole("button", { name: "New order for this customer" })).toBeInTheDocument();
  });
});

describe("navigation and new-order cart handoff", () => {
  it("customer nav says My orders and offers Create an order", () => {
    const customer = (ordersFeature.nav ?? []).filter((item) => item.area === "customer").map((item) => [item.label, item.href, item.order]);
    expect(customer).toEqual([
      ["My orders", "/orders", 10],
      ["Create an order", "/orders/new", 12],
    ]);
  });

  it("with the cart feature on, the wizard adds to the cart instead of creating an order", async () => {
    flags.add("cart");
    handlers.set("orders.catalog.list", () => [
      { publicId: "01JTESTGROUP000000000000A", groupKey: null, packetNumber: null, name: "Synthetic group", description: "", sortOrder: 0, active: true, rowVersion: 1, products: [{ publicId: "01JTESTPROD000000000000A1", productKey: "synthetic-a", groupPublicId: "01JTESTGROUP000000000000A", packetNumber: null, tier: null, outcome: "", timeline: "", deliverables: [], name: "Synthetic A", description: "", features: [], priceMinor: 1000, currency: "USD", versionNumber: 1, versionPublicId: "x", sortOrder: 0, active: true, rowVersion: 1 }] },
    ]);
    handlers.set("orders.quote", () => ({ currency: "USD", subtotalMinor: 1000, discountMinor: 0, discountLabel: null, totalMinor: 1000, bundle: null }));
    handlers.set("cart.addItems", () => ({ lines: [] }));
    const user = userEvent.setup();
    const { location } = renderUi(<NewOrderPage />, { path: "/orders/new" });
    await user.type(await screen.findByLabelText(/Synthetic A/), "1");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(await screen.findByLabelText(/Project name/), "Synthetic cart project");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Add to cart" }));
    await waitFor(() => expect(location.history?.at(-1)).toBe("/cart"));
    expect(calls.find((c) => c.path === "cart.addItems")?.input).toEqual({ items: [{ productPublicId: "01JTESTPROD000000000000A1", quantity: 1 }], projectName: "Synthetic cart project" });
    expect(calls.some((c) => c.path === "orders.create")).toBe(false);
  });
});

describe("designer rule helpers", () => {
  const base: DraftDefinition = {
    states: [
      { key: "intake", label: "Intake", customerLabel: "Intake", kind: "initial", tone: "info", phase: "p1" },
      { key: "done", label: "Done", customerLabel: "Done", kind: "terminal", tone: "success" },
    ],
    transitions: [{ from: "intake", to: "done", allowedBy: ["staff"], notifyCustomer: true, requiresNote: false }],
    phases: [{ key: "p1", label: "Phase one" }],
  };

  it("offers the API integration actor and a Phases and requirements step", () => {
    expect(ACTORS.map((actor) => actor.value)).toEqual(["customer", "staff", "admin", "api"]);
    expect(WIZARD_STEPS.map((step) => step.id)).toEqual(["statuses", "transitions", "who", "notices", "rules", "review"]);
    expect(stepOfIssue({ code: "UPLOAD_MIN_ABOVE_MAX", severity: "error", path: "states.0.requirements.uploads.0.minCount", message: "x" })).toBe("rules");
  });

  it("phase edits carry statuses along and status edits keep phases", () => {
    const renamed = updatePhase(base, 0, { key: "intake_phase" });
    expect(renamed.states[0]!.phase).toBe("intake_phase");
    expect(addPhase(base).phases).toHaveLength(2);
    const removed = removePhase(base, 0);
    expect(removed.phases).toEqual([]);
    expect(removed.states[0]).not.toHaveProperty("phase");
    const edited = updateState(base, { nodes: [] }, 1, { label: "Finished" }).definition;
    expect(edited.phases).toEqual(base.phases);
  });

  it("requirement patches drop empty lists and file types are normalised", () => {
    const state = base.states[0]!;
    expect(withRequirements(state, (current) => current)).toEqual({ requirements: undefined });
    expect(parseTypes(" .PDF, docx  mp3,,")).toEqual(["pdf", "docx", "mp3"]);
  });
});

describe("increment 04 page accessibility", () => {
  pageA11y("order page with phases and checklist", async () => {
    document.title = "Order · ReadyPackets";
    renderCustomerOrder();
    await screen.findByRole("heading", { name: "Needed before the next step (Intake)" });
  });

  pageA11y("acknowledgement dialog open", async () => {
    document.title = "Order · ReadyPackets";
    const user = userEvent.setup();
    renderCustomerOrder();
    await user.click(await screen.findByRole("button", { name: "Read and accept: Synthetic terms" }));
    await screen.findByRole("dialog", { name: "Synthetic terms" });
  });

  pageA11y("console customer orders tab", async () => {
    session.role = "staff";
    document.title = "Customer · ReadyPackets";
    handlers.set("orders.admin.list", () => ({ items: [], nextCursor: null }));
    renderUi(
      <main>
        <h1>Synthetic Customer B</h1>
        <CustomerOrdersTab customerId={CUSTOMER_ID} />
      </main>,
    );
    await screen.findByText("No orders yet.");
  });
});
