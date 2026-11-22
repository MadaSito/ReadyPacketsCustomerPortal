import type { ReactElement } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "wouter";
import type * as trpcModule from "@/lib/trpc";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import { complianceAdminNav, complianceAdminRoutes } from "./index";
import IntakeAdminPage from "./IntakeAdminPage";
import IntakeSubmissionsPage from "./IntakeSubmissionsPage";
import InvoiceDetailPage from "./InvoiceDetailPage";
import InvoicesAdminPage from "./InvoicesAdminPage";
import PoliciesAdminPage from "./PoliciesAdminPage";
import PolicyDetailPage from "./PolicyDetailPage";
import { OrderInvoicesTab } from "../customer/InvoicePages";
import { acceptanceCounts, blankField, draftsToFields, type FieldDraft, type PolicyAcceptance } from "./model";

/** Generic fake of the tRPC/TanStack proxy: every procedure path resolves through `handlers`. */
const { handlers, calls, session } = vi.hoisted(() => ({
  handlers: new Map<string, (input: unknown) => unknown>(),
  calls: [] as { path: string; input: unknown }[],
  session: { role: "admin" as string },
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
    queryKey: (input?: unknown) => [key, input],
    pathKey: () => [key],
  };
  return new Proxy(api, { get: (target, prop: string) => (prop in target ? target[prop as keyof typeof target] : proxy([...path, prop])) });
}

vi.mock("@/lib/trpc", async (original) => ({ ...(await original<typeof trpcModule>()), useTRPC: () => proxy([]) }));
vi.mock("@/lib/session", () => ({ useSession: () => ({ me: { state: "full", user: { role: session.role } }, view: { status: "full", role: session.role } }) }));

const now = new Date("2026-11-20T09:00:00.000Z");
const DOC = "01JTEST0000000000000000001";
const V1 = "01JTEST0000000000000000002";
const V2 = "01JTEST0000000000000000003";
const USER = "01JTEST0000000000000000004";
const ORDER = "01JTEST0000000000000000005";
const QN = "01JTEST0000000000000000006";
const INV = "01JTEST0000000000000000007";
const PAY = "01JTESTPAYMENT00000000000A";
const HASH = "a".repeat(64);

const callsTo = (path: string) => calls.filter((c) => c.path === path);
const pageByPath = (path: string, element: ReactElement, pattern: string) => renderUi(<Route path={pattern}>{element}</Route>, { path });

beforeEach(() => {
  handlers.clear();
  calls.length = 0;
  session.role = "admin";
});

describe("registry exports", () => {
  it("exports lazy console routes and nav items with capabilities", () => {
    expect(complianceAdminRoutes.map((r) => r.path)).toEqual(["/admin/policies", "/admin/policies/:documentId", "/admin/intake", "/admin/intake/submissions", "/admin/invoices", "/admin/invoices/:invoiceId"]);
    for (const route of complianceAdminRoutes) expect(route.capability).toBeTruthy();
    expect(complianceAdminRoutes.every((r) => r.path.startsWith("/admin/") && (r.access === "admin" || r.access === "staff"))).toBe(true);
    expect(complianceAdminNav.every((n) => n.area === "console" && complianceAdminRoutes.some((r) => r.path === n.href))).toBe(true);
  });
});

describe("policies", () => {
  const summary = {
    documentPublicId: DOC,
    slug: "terms-of-service",
    title: "Terms of service",
    audience: "customer",
    requiresAcceptance: true,
    requiresTypedSignature: false,
    active: true,
    version: 2,
    currentPublishedVersion: { versionPublicId: V1, versionNumber: 1, versionLabel: "1.0", contentHash: HASH, effectiveAt: now, publishedAt: now },
    draftCount: 1,
    publishedCount: 1,
    updatedAt: now,
  };
  const version = (id: string, n: number, status: "draft" | "published") => ({
    versionPublicId: id,
    versionNumber: n,
    versionLabel: `${n}.0`,
    status,
    contentFormat: "safe_markdown",
    bodyText: `# Heading ${n}\n\nSynthetic policy text.`,
    contentHash: HASH,
    changeSummary: null,
    effectiveAt: now,
    publishedAt: status === "published" ? now : null,
    origin: "portal",
    createdAt: now,
  });
  const acceptance = (id: string, versionPublicId: string, n: number, typed = false) => ({
    acceptancePublicId: id,
    documentPublicId: DOC,
    slug: "terms-of-service",
    title: "Terms of service",
    versionPublicId,
    versionNumber: n,
    versionLabel: `${n}.0`,
    versionContentHash: HASH,
    acceptedAt: now,
    requestId: "req-1",
    method: typed ? "typed_signature" : "portal_checkbox",
    hasTypedSignature: typed,
    orderPublicId: null,
    origin: "portal",
    userPublicId: USER,
    sourceAddressPseudonym: null,
  });

  it("shows a guiding empty state with no axe violations", async () => {
    handlers.set("compliance.policies.admin.listDocuments", () => []);
    const { container } = renderUi(<PoliciesAdminPage />, { path: "/admin/policies" });
    expect(await screen.findByText("No policies yet")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    await expectNoAxeViolations(container);
  });

  it("lists documents and creates a draft policy, then opens it", async () => {
    handlers.set("compliance.policies.admin.listDocuments", () => [summary]);
    handlers.set("compliance.policies.admin.createDocument", () => ({ documentPublicId: DOC, draftVersionPublicId: V2, contentHash: HASH }));
    const user = userEvent.setup();
    const { container, location } = renderUi(<PoliciesAdminPage />, { path: "/admin/policies" });
    expect((await screen.findAllByRole("link", { name: "Terms of service" }))[0]).toHaveAttribute("href", `/admin/policies/${DOC}`);
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole("button", { name: "New policy" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Create draft" }));
    expect(await within(dialog).findByText(/address name must be/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/^Title/), "Privacy notice");
    await user.type(within(dialog).getByLabelText(/^Address name/), "privacy-notice");
    await user.type(within(dialog).getByLabelText(/^Policy text/), "We keep only what we need.");
    await expectNoAxeViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(location.history.at(-1)).toBe(`/admin/policies/${DOC}`));
    expect(callsTo("compliance.policies.admin.createDocument")[0]?.input).toMatchObject({ slug: "privacy-notice", title: "Privacy notice", audience: "customer", requiresAcceptance: true, versionLabel: "1.0" });
  });

  it("shows versions, acceptance statistics and evidence, and publishes a draft only after typed confirmation", async () => {
    handlers.set("compliance.policies.admin.getDocument", () => ({ document: { ...summary }, versions: [version(V2, 2, "draft"), version(V1, 1, "published")] }));
    handlers.set("compliance.policies.admin.listAcceptances", () => ({ items: [acceptance("01JTESTACCEPT0000000000001", V1, 1), acceptance("01JTESTACCEPT0000000000002", V1, 1, true)], nextCursor: null }));
    handlers.set("compliance.policies.admin.publishVersion", () => ({ versionPublicId: V2 }));
    const user = userEvent.setup();
    const { container } = pageByPath(`/admin/policies/${DOC}`, <PolicyDetailPage />, "/admin/policies/:documentId");
    expect(await screen.findByRole("heading", { level: 1, name: "Terms of service" })).toBeInTheDocument();
    expect(await screen.findByText("v1 · 1.0: 2 accepted, 1 signed")).toBeInTheDocument();
    expect(screen.getByText("Counts include every matching record.")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: USER })[0]).toHaveAttribute("href", `/admin/customers/${USER}`);
    await expectNoAxeViolations(container);

    await user.click(screen.getAllByRole("button", { name: "Publish version 2" })[0]!);
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Publish version" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Type 2.0 to confirm/), "2.0");
    expect(confirm).toBeEnabled();
    await expectNoAxeViolations(dialog);
    await user.click(confirm);
    await waitFor(() => expect(callsTo("compliance.policies.admin.publishVersion")).toHaveLength(1));
    expect((callsTo("compliance.policies.admin.publishVersion")[0]?.input as { versionPublicId: string; effectiveAt: Date }).versionPublicId).toBe(V2);
    expect((callsTo("compliance.policies.admin.publishVersion")[0]?.input as { effectiveAt: Date }).effectiveAt).toBeInstanceOf(Date);
  });

  it("filters evidence by version and customer and marks partial counts", async () => {
    handlers.set("compliance.policies.admin.getDocument", () => ({ document: { ...summary }, versions: [version(V1, 1, "published")] }));
    handlers.set("compliance.policies.admin.listAcceptances", () => ({ items: [acceptance("01JTESTACCEPT0000000000001", V1, 1)], nextCursor: "next" }));
    const user = userEvent.setup();
    pageByPath(`/admin/policies/${DOC}`, <PolicyDetailPage />, "/admin/policies/:documentId");
    expect(await screen.findByText("v1 · 1.0: 1+ accepted")).toBeInTheDocument();
    const customer = screen.getAllByLabelText("Customer ID")[0]!;
    await user.type(customer, "not-an-id{Enter}");
    expect(await screen.findByText(/customer ID is 26 characters/)).toBeInTheDocument();
    await user.clear(customer);
    await user.type(customer, `${USER}{Enter}`);
    await waitFor(() => expect(callsTo("compliance.policies.admin.listAcceptances").some((c) => (c.input as { userPublicId?: string }).userPublicId === USER)).toBe(true));
  });

  it("counts acceptances per version", () => {
    const items = [
      { versionPublicId: "a", versionLabel: "1.0", versionNumber: 1, hasTypedSignature: false },
      { versionPublicId: "b", versionLabel: "2.0", versionNumber: 2, hasTypedSignature: true },
      { versionPublicId: "a", versionLabel: "1.0", versionNumber: 1, hasTypedSignature: true },
    ] as PolicyAcceptance[];
    expect(acceptanceCounts(items)).toEqual([
      { versionPublicId: "b", versionLabel: "2.0", versionNumber: 2, count: 1, typed: 1 },
      { versionPublicId: "a", versionLabel: "1.0", versionNumber: 1, count: 2, typed: 1 },
    ]);
  });
});

describe("intake builder", () => {
  const field = (patch: Partial<FieldDraft>): FieldDraft => ({ ...blankField(), key: "company_name", label: "Company name", ...patch });

  it("validates and converts builder drafts", () => {
    expect(draftsToFields([])).toEqual({ error: expect.stringContaining("between 1 and 40") });
    expect(draftsToFields([field({ key: "Bad Key" })])).toEqual({ error: expect.stringContaining("key must be") });
    expect(draftsToFields([field({}), field({})])).toEqual({ error: expect.stringContaining("already used") });
    expect(draftsToFields([field({ type: "single_choice", options: "" })])).toEqual({ error: expect.stringContaining("options") });
    expect(draftsToFields([field({ type: "short_text", maxLength: "900" })])).toEqual({ error: expect.stringContaining("1 to 500") });
    expect(draftsToFields([field({ type: "multi_choice", options: "a | Alpha\nb", minSelections: "1", maxSelections: "2", section: "About", required: false })])).toEqual({
      fields: [{ key: "company_name", label: "Company name", type: "multi_choice", required: false, sensitive: true, section: "About", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "b" }], minSelections: 1, maxSelections: 2 }],
    });
  });

  it("lists questionnaires, creates one with the field builder and publishes a draft after typed confirmation", async () => {
    handlers.set("compliance.intake.admin.listQuestionnaires", () => [
      { questionnairePublicId: QN, slug: "project-intake", title: "Project intake", description: null, scopeKind: "default", scopeRef: null, active: true, version: 1, currentPublishedVersion: null, draftVersionPublicId: "01JTEST0000000000000000008", updatedAt: now },
    ]);
    handlers.set("compliance.intake.admin.createQuestionnaire", () => ({ questionnairePublicId: QN }));
    handlers.set("compliance.intake.admin.publishVersion", () => ({}));
    const user = userEvent.setup();
    const { container } = renderUi(<IntakeAdminPage />, { path: "/admin/intake" });
    expect((await screen.findAllByText("Project intake"))[0]).toBeInTheDocument();
    expect(screen.getAllByText("All orders")[0]).toBeInTheDocument();
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole("button", { name: "New questionnaire" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Title/), "Onboarding");
    await user.type(within(dialog).getByLabelText(/^Identifier/), "onboarding");
    await user.type(within(dialog).getByLabelText(/^Question/), "Company name");
    await user.type(within(dialog).getByLabelText(/^Key/), "company_name");
    await user.click(within(dialog).getByRole("button", { name: "Add question" }));
    await user.click(within(dialog).getByRole("button", { name: "Create draft" }));
    expect(await within(dialog).findByText(/Question 2: the key must be/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Remove question 2" }));
    await expectNoAxeViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(callsTo("compliance.intake.admin.createQuestionnaire")).toHaveLength(1));
    expect(callsTo("compliance.intake.admin.createQuestionnaire")[0]?.input).toMatchObject({ slug: "onboarding", title: "Onboarding", scopeKind: "default", fields: [{ key: "company_name", label: "Company name", type: "short_text" }] });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getAllByRole("button", { name: "Publish Project intake" })[0]!);
    const confirm = await screen.findByRole("alertdialog");
    await user.type(within(confirm).getByLabelText(/to confirm/), "project-intake");
    await user.click(within(confirm).getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(callsTo("compliance.intake.admin.publishVersion")[0]?.input).toEqual({ versionPublicId: "01JTEST0000000000000000008" }));
  });
});

describe("intake submissions", () => {
  const item = {
    questionnairePublicId: QN,
    slug: "project-intake",
    title: "Project intake",
    description: null,
    scopeKind: "default",
    scopeRef: null,
    boundVersion: {
      versionPublicId: "01JTEST0000000000000000008",
      versionNumber: 1,
      schemaHash: HASH,
      fields: [
        { key: "company_name", label: "Company name", type: "short_text", required: true, sensitive: false },
        { key: "size", label: "Team size", type: "single_choice", required: true, sensitive: true, options: [{ value: "s", label: "Small" }] },
      ],
    },
    submission: { submissionPublicId: "01JTEST0000000000000000009", status: "submitted", revisionNumber: 2, answers: { company_name: "Synthetic Co", size: "s" }, latestReviewNote: null, submittedAt: now, reviewedAt: null, origin: "portal", updatedAt: now },
    canWrite: false,
    canReview: true,
  };

  it("loads an order from the link, shows answers and revisions, and requires a note to return for changes", async () => {
    session.role = "staff";
    handlers.set("compliance.intake.listForOrder", () => ({ orderPublicId: ORDER, orderReference: "RP-2026-000001", lockState: "none", items: [item] }));
    handlers.set("compliance.intake.getSubmission", () => ({
      item,
      revisions: [{ revisionPublicId: "01JTEST0000000000000000010", revisionNumber: 2, eventKind: "submitted", actorRole: "customer", answers: item.submission.answers, reviewNote: null, occurredAt: now }],
      nextCursor: null,
    }));
    handlers.set("compliance.intake.review", () => ({}));
    const user = userEvent.setup();
    const { container } = renderUi(<IntakeSubmissionsPage />, { path: `/admin/intake/submissions?order=${ORDER}` });
    expect((await screen.findAllByText("Synthetic Co"))[0]).toBeInTheDocument();
    expect(screen.getAllByText("Small")[0]).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "RP-2026-000001" })[0]).toHaveAttribute("href", `/admin/orders/${ORDER}`);
    await user.click(screen.getByRole("button", { name: /Show revision history/ }));
    expect((await screen.findAllByText("#2"))[0]).toBeInTheDocument();
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole("button", { name: "Review Project intake" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: "Return for changes" }));
    await user.click(within(dialog).getByRole("button", { name: "Save review" }));
    expect(await within(dialog).findByText("Tell the customer what needs to change.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Note to the customer/), "Please add the team size.");
    await user.click(within(dialog).getByRole("button", { name: "Save review" }));
    await waitFor(() => expect(callsTo("compliance.intake.review")[0]?.input).toEqual({ submissionPublicId: "01JTEST0000000000000000009", decision: "returned_for_changes", reviewNote: "Please add the team size." }));
  });

  it("validates the order ID before loading", async () => {
    const user = userEvent.setup();
    renderUi(<IntakeSubmissionsPage />, { path: "/admin/intake/submissions" });
    await user.type(screen.getByLabelText(/Order ID/), "abc");
    await user.click(screen.getByRole("button", { name: "Show submissions" }));
    expect(await screen.findByText(/26-character order ID/)).toBeInTheDocument();
    expect(callsTo("compliance.intake.listForOrder")).toHaveLength(0);
  });
});

describe("invoices", () => {
  const summary = {
    invoicePublicId: INV,
    orderPublicId: ORDER,
    orderReference: "RP-2026-000001",
    invoiceNumber: "INV-2026-0001",
    status: "issued",
    paymentState: "partially_paid" as const,
    currency: "USD",
    subtotalMinor: 10000,
    discountMinor: 0,
    taxMinor: 825,
    totalMinor: 10825,
    grossPaidMinor: 5000,
    refundedMinor: 0,
    netPaidMinor: 5000,
    balanceDueMinor: 5825,
    issuedAt: now,
    dueAt: now,
    voidedAt: null,
    origin: "portal",
    version: 3,
    createdAt: now,
  };
  const detail = {
    ...summary,
    bundleDiscountMinor: 0,
    discountLabel: null,
    promoDiscountMinor: 0,
    promoLabel: null,
    issuerName: "Synthetic issuer",
    issuerAddress: "",
    memo: null,
    voidReason: null,
    paymentInstructions: "",
    onlinePaymentConfigured: false,
    onlinePaymentMessage: null,
    lines: [{ linePublicId: "01JTEST0000000000000000011", position: 1, description: "Synthetic service", quantity: 2, unitAmountMinor: 5000, lineTotalMinor: 10000 }],
    payments: [{ paymentPublicId: PAY, method: "wire", status: "succeeded", amountMinor: 5000, currency: "USD", reference: "WIRE-1", provider: null, notes: null, receivedAt: now, origin: "portal" }],
    refunds: [],
    canManage: true,
    canRecordPayment: true,
  };

  it("lists invoices with money in minor units and filters by status", async () => {
    session.role = "staff";
    handlers.set("compliance.invoices.admin.list", () => ({ items: [summary], nextCursor: null }));
    const user = userEvent.setup();
    const { container } = renderUi(<InvoicesAdminPage />, { path: "/admin/invoices" });
    expect((await screen.findAllByRole("link", { name: "INV-2026-0001" }))[0]).toHaveAttribute("href", `/admin/invoices/${INV}`);
    expect(screen.getByText(/Online payments and refunds are handled from the order's Refund tab and Payments settings\./)).toBeInTheDocument();
    expect(screen.queryByText(/not available in this release/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("$58.25")[0]).toBeInTheDocument();
    await expectNoAxeViolations(container);
    await user.selectOptions(screen.getAllByLabelText("Status")[0]!, "paid");
    await waitFor(() => expect(callsTo("compliance.invoices.admin.list").some((c) => (c.input as { status?: string }).status === "paid")).toBe(true));
  });

  it("creates a draft invoice with lines in minor units", async () => {
    handlers.set("compliance.invoices.admin.list", () => ({ items: [], nextCursor: null }));
    handlers.set("compliance.invoices.admin.createDraft", () => ({ invoicePublicId: INV, totalMinor: 25050, currency: "USD" }));
    const user = userEvent.setup();
    const { location } = renderUi(<InvoicesAdminPage />, { path: "/admin/invoices" });
    await user.click(await screen.findByRole("button", { name: "New invoice" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Order ID/), ORDER);
    await user.type(within(dialog).getByLabelText("Line 1 description"), "Synthetic review");
    await user.clear(within(dialog).getByLabelText("Quantity"));
    await user.type(within(dialog).getByLabelText("Quantity"), "2");
    await user.type(within(dialog).getByLabelText("Unit price"), "125.25");
    expect(within(dialog).getAllByText("$250.50").length).toBeGreaterThan(0);
    await expectNoAxeViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(location.history.at(-1)).toBe(`/admin/invoices/${INV}`));
    expect(callsTo("compliance.invoices.admin.createDraft")[0]?.input).toMatchObject({ orderPublicId: ORDER, currency: "USD", lines: [{ description: "Synthetic review", quantity: 2, unitAmountMinor: 12525 }], discountMinor: 0, taxMinor: 0 });
  });

  it("shows detail, balance and the order Refund tab link, and records a manual payment with typed confirmation and a stable idempotency key", async () => {
    handlers.set("compliance.invoices.get", () => detail);
    let attempts = 0;
    handlers.set("compliance.invoices.admin.recordManualPayment", () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Network hiccup");
      return { paymentPublicId: "p2" };
    });
    const user = userEvent.setup();
    const { container } = pageByPath(`/admin/invoices/${INV}`, <InvoiceDetailPage />, "/admin/invoices/:invoiceId");
    expect(await screen.findByRole("heading", { level: 1, name: "Invoice INV-2026-0001" })).toBeInTheDocument();
    expect(screen.getByText("Payments and refunds")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "order's Refund tab" })).toHaveAttribute("href", `/admin/orders/${ORDER}/refund`);
    expect(screen.queryByText(/not available in this release/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("$58.25").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /Download PDF/ })[0]).toBeInTheDocument();
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole("button", { name: "Record payment" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByLabelText(/^Amount/)).toHaveValue("58.25");
    await user.type(within(dialog).getByLabelText(/^Reference/), "WIRE-2");
    const confirm = within(dialog).getByRole("button", { name: "Record payment" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Type INV-2026-0001 to confirm/), "INV-2026-0001");
    await expectNoAxeViolations(dialog);
    await user.click(confirm);
    expect(await within(dialog).findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    await user.click(confirm);
    await waitFor(() => expect(callsTo("compliance.invoices.admin.recordManualPayment")).toHaveLength(2));
    const [first, second] = callsTo("compliance.invoices.admin.recordManualPayment").map((c) => c.input as { idempotencyKey: string; amountMinor: number; method: string });
    expect(first).toMatchObject({ invoicePublicId: INV, amountMinor: 5825, currency: "USD", method: "bank_transfer", reference: "WIRE-2" });
    expect(first!.idempotencyKey.length).toBeGreaterThanOrEqual(8);
    expect(second!.idempotencyKey).toBe(first!.idempotencyKey);
  });

  it("refunds at most the refundable amount and voids only with a reason and typed confirmation", async () => {
    handlers.set("compliance.invoices.get", () => detail);
    handlers.set("compliance.invoices.admin.recordRefund", () => ({ refundPublicId: "r1" }));
    handlers.set("compliance.invoices.admin.void", () => ({ invoicePublicId: INV, status: "void", voidedAt: now }));
    const user = userEvent.setup();
    pageByPath(`/admin/invoices/${INV}`, <InvoiceDetailPage />, "/admin/invoices/:invoiceId");
    await user.click((await screen.findAllByRole("button", { name: "Refund payment WIRE-1" }))[0]!);
    let dialog = await screen.findByRole("alertdialog");
    await user.clear(within(dialog).getByLabelText(/^Amount/));
    await user.type(within(dialog).getByLabelText(/^Amount/), "60");
    await user.selectOptions(within(dialog).getByLabelText(/^Reason/), "OVERPAYMENT");
    await user.type(within(dialog).getByLabelText(/^Reference/), "RF-1");
    await user.type(within(dialog).getByLabelText(/to confirm/), "REFUND ORDER");
    await user.click(within(dialog).getByRole("button", { name: "Record refund" }));
    expect(await within(dialog).findByText(/from 0.01 to 50.00/)).toBeInTheDocument();
    expect(callsTo("compliance.invoices.admin.recordRefund")).toHaveLength(0);
    await user.clear(within(dialog).getByLabelText(/^Amount/));
    await user.type(within(dialog).getByLabelText(/^Amount/), "20");
    await user.click(within(dialog).getByRole("button", { name: "Record refund" }));
    await waitFor(() =>
      expect(callsTo("compliance.invoices.admin.recordRefund")[0]?.input).toMatchObject({
        paymentPublicId: PAY,
        amountMinor: 2000,
        reasonCode: "OVERPAYMENT",
        reference: "RF-1",
        currency: "USD",
        confirmationPhrase: "REFUND ORDER",
      }),
    );
    expect((callsTo("compliance.invoices.admin.recordRefund")[0]?.input as { idempotencyKey: string }).idempotencyKey.length).toBeGreaterThanOrEqual(8);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Void" }));
    dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText(/to confirm/), "INV-2026-0001");
    await user.click(within(dialog).getByRole("button", { name: "Void invoice" }));
    expect(await within(dialog).findByText(/at least 3 characters/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/^Reason/), "Issued in error");
    await user.click(within(dialog).getByRole("button", { name: "Void invoice" }));
    await waitFor(() => expect(callsTo("compliance.invoices.admin.void")[0]?.input).toEqual({ invoicePublicId: INV, reason: "Issued in error" }));
  });

  it("hides management actions when the server says the viewer cannot manage", async () => {
    session.role = "staff";
    handlers.set("compliance.invoices.get", () => ({ ...detail, canManage: false, canRecordPayment: false }));
    pageByPath(`/admin/invoices/${INV}`, <InvoiceDetailPage />, "/admin/invoices/:invoiceId");
    expect(await screen.findByRole("heading", { level: 1, name: "Invoice INV-2026-0001" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record payment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Void" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Refund payment/ })).not.toBeInTheDocument();
  });

  it("console OrderInvoicesTab offers New invoice for this order for staff with invoices.manage and links invoices to /admin/invoices/:id", async () => {
    session.role = "staff";
    handlers.set("compliance.invoices.listForOrder", () => ({
      orderPublicId: ORDER,
      orderReference: "RP-2026-000001",
      lockState: "none",
      onlinePaymentConfigured: false,
      items: [],
    }));
    const emptyView = renderUi(
      <>
        <h1>Order RP-2026-000001</h1>
        <OrderInvoicesTab orderId={ORDER} area="console" />
      </>,
    );
    const emptyCreateLink = await screen.findByRole("link", { name: "New invoice for this order" });
    expect(emptyCreateLink).toHaveAttribute("href", `/admin/invoices?order=${ORDER}`);
    await expectNoAxeViolations(emptyView.container);
    emptyView.unmount();

    const draftSummary = {
      ...summary,
      invoicePublicId: "01JTEST0000000000000000099",
      invoiceNumber: null,
      status: "draft" as const,
      issuedAt: null,
    };
    handlers.set("compliance.invoices.listForOrder", () => ({
      orderPublicId: ORDER,
      orderReference: "RP-2026-000001",
      lockState: "none",
      onlinePaymentConfigured: false,
      items: [summary, draftSummary],
    }));
    const populatedView = renderUi(
      <>
        <h1>Order RP-2026-000001</h1>
        <OrderInvoicesTab orderId={ORDER} area="console" />
      </>,
    );
    expect(await screen.findByRole("link", { name: "INV-2026-0001" })).toHaveAttribute("href", `/admin/invoices/${INV}`);
    expect(screen.getByRole("link", { name: "Draft invoice" })).toHaveAttribute("href", `/admin/invoices/${draftSummary.invoicePublicId}`);
    expect(screen.getByRole("link", { name: "New invoice for this order" })).toHaveAttribute("href", `/admin/invoices?order=${ORDER}`);
    await expectNoAxeViolations(populatedView.container);
    populatedView.unmount();

    session.role = "customer";
    renderUi(<OrderInvoicesTab orderId={ORDER} area="console" />);
    expect(await screen.findByRole("link", { name: "INV-2026-0001" })).toHaveAttribute("href", `/admin/invoices/${INV}`);
    expect(screen.queryByRole("link", { name: "New invoice for this order" })).not.toBeInTheDocument();
  });
});
