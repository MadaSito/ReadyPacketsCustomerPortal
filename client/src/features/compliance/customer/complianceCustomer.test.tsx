import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { lazy, Suspense, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceDetailView } from "@server/modules/compliance/invoicesService";
import type { OrderIntakeItemView } from "@server/modules/compliance/intakeService";
import type { PublishedPolicyView } from "@server/modules/compliance/policiesService";
import type * as sessionModule from "@/lib/sessionTransport";
import type * as trpcModule from "@/lib/trpc";
import { createTestQueryClient, expectNoAxeViolations, renderUi } from "@/ui/testing";
import { Route } from "wouter";
import { InvoiceDetailPage, InvoicesPage, OrderInvoicesTab } from "./InvoicePages";
import OrderIntakeTab from "./OrderIntakeTab";
import PolicyAcceptanceWidget, { RequiredPolicyGate } from "./PolicyAcceptance";
import { LegalPage, MyPoliciesPage } from "./PolicyPages";

const mocks = vi.hoisted(() => ({
  policyStatus: vi.fn(), published: vi.fn(), accept: vi.fn(), intakeList: vi.fn(), history: vi.fn(),
  save: vi.fn(), submit: vi.fn(), invoiceList: vi.fn(), orderInvoices: vi.fn(), invoice: vi.fn(),
  receiptList: vi.fn(), orderReceipts: vi.fn(), receipt: vi.fn(), fetch: vi.fn(),
}));
vi.mock("@/lib/sessionTransport", async (load) => ({ ...await load<typeof sessionModule>(), sessionFetch: mocks.fetch }));
vi.mock("@/lib/trpc", async (load) => {
  const query = (name: string, fn: (input: unknown) => unknown) => ({
    queryOptions: (input?: object, options?: object) => ({ queryKey: [name, input ?? null], queryFn: () => fn(input), ...options }),
    queryKey: (input?: object) => [name, input ?? null],
    pathKey: () => [name],
    infiniteQueryOptions: (input: object, options: object) => ({
      queryKey: [name, input], initialPageParam: undefined,
      queryFn: ({ pageParam }: { pageParam: string | undefined }) => fn({ ...input, cursor: pageParam }), ...options,
    }),
  });
  const mutation = (fn: (input: unknown) => unknown) => ({ mutationOptions: () => ({ mutationFn: fn }) });
  return {
    ...await load<typeof trpcModule>(),
    useTRPC: () => ({
      compliance: {
        policies: {
          listPublished: query("published", mocks.published), myStatus: query("status", mocks.policyStatus), accept: mutation(mocks.accept),
        },
        intake: {
          listForOrder: query("intake", mocks.intakeList), getSubmission: query("history", mocks.history),
          saveDraft: mutation(mocks.save), submit: mutation(mocks.submit),
        },
        invoices: {
          listMine: query("invoices", mocks.invoiceList), get: query("invoice", mocks.invoice),
          listForOrder: query("order-invoices", mocks.orderInvoices),
        },
        receipts: {
          myList: query("receipts", mocks.receiptList),
          forOrder: query("order-receipts", mocks.orderReceipts),
          get: query("receipt", mocks.receipt),
        },
      },
    }),
  };
});

const date = new Date("2026-08-15T12:00:00Z");
const publicId = (end: string) => `01JJ${"0".repeat(21)}${end}`;
const orderId = publicId("1");
const document: PublishedPolicyView = {
  documentPublicId: publicId("2"), versionPublicId: publicId("3"), slug: "terms", title: "Service terms",
  audience: "all", requiresAcceptance: true, requiresTypedSignature: false, versionNumber: 2, versionLabel: "August terms",
  contentFormat: "safe_markdown", bodyText: "# Scope\n\n**Terms apply.**\n\n<img src=x onerror=alert(1)>",
  changeSummary: "Updated scope.", contentHash: "a".repeat(64), effectiveAt: date, publishedAt: date,
};
const intake: OrderIntakeItemView = {
  questionnairePublicId: publicId("4"), slug: "brief", title: "Project brief", description: "Tell us about your project.",
  scopeKind: "default", scopeRef: null, canWrite: true, canReview: false,
  boundVersion: {
    versionPublicId: publicId("5"), versionNumber: 1, schemaHash: "b".repeat(64),
    fields: [
      { key: "name", label: "Project name", section: "Basics", type: "short_text", required: true, sensitive: false, minLength: 3 },
      { key: "details", label: "Notes", type: "long_text", required: false, sensitive: true },
      { key: "category", label: "Category", type: "single_choice", required: false, sensitive: false, options: [{ value: "studio", label: "Studio" }] },
      { key: "outputs", label: "Outputs", type: "multi_choice", required: false, sensitive: false, options: [{ value: "mix", label: "Mix" }] },
      { key: "due", label: "Requested date", type: "date", required: false, sensitive: false },
      { key: "count", label: "Track count", type: "number", required: false, sensitive: false, minNumber: 1 },
    ],
  },
  submission: null,
};
const invoice: InvoiceDetailView = {
  invoicePublicId: publicId("6"), orderPublicId: orderId, orderReference: "RP-123", invoiceNumber: "RP-INV-123",
  status: "issued", paymentState: "partially_refunded", currency: "USD", subtotalMinor: 10000, discountMinor: 0,
  bundleDiscountMinor: 0, discountLabel: null, promoDiscountMinor: 0, promoLabel: null, taxMinor: 0, totalMinor: 10000,
  grossPaidMinor: 4000, waivedMinor: 0, refundedMinor: 1000, netPaidMinor: 3000, balanceDueMinor: 7000, issuedAt: date,
  dueAt: date, voidedAt: null, origin: "portal", version: 1, createdAt: date, issuerName: "ReadyPackets",
  issuerAddress: "", memo: null, voidReason: null, paymentInstructions: "", onlinePaymentConfigured: false,
  onlinePaymentMessage: null, canManage: false, canRecordPayment: false,
  lines: [{ linePublicId: publicId("7"), position: 1, description: "Mixing", quantity: 2, unitAmountMinor: 5000, lineTotalMinor: 10000 }],
  payments: [{ paymentPublicId: publicId("8"), method: "wire", status: "succeeded", amountMinor: 4000, currency: "USD",
    reference: "Wire ABC", provider: null, notes: null, receivedAt: date, origin: "portal" }],
  refunds: [{ refundPublicId: publicId("9"), paymentPublicId: publicId("8"), amountMinor: 1000, currency: "USD",
    reference: "Refund ABC", provider: null, reasonCode: "ADJUSTMENT", notes: null, refundedAt: date, origin: "portal" }],
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.published.mockResolvedValue([document]);
  mocks.policyStatus.mockResolvedValue({ published: [document], pendingRequired: [document], acceptances: [] });
  mocks.accept.mockResolvedValue({ acceptancePublicId: publicId("A"), duplicate: false });
  mocks.intakeList.mockResolvedValue({ lockState: "none", items: [intake] });
  mocks.save.mockResolvedValue({ submissionPublicId: publicId("B"), status: "draft", revisionNumber: 1 });
  mocks.submit.mockResolvedValue({ submissionPublicId: publicId("B"), status: "submitted", revisionNumber: 2 });
  mocks.history.mockResolvedValue({ item: intake, revisions: [], nextCursor: null });
  mocks.invoiceList.mockResolvedValue({ items: [invoice], nextCursor: null });
  mocks.orderInvoices.mockResolvedValue({ items: [invoice] });
  mocks.invoice.mockResolvedValue(invoice);
  mocks.receiptList.mockResolvedValue({ items: [], nextCursor: null });
  mocks.orderReceipts.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("customer policy review", () => {
  it("opens an accessible dashboard dialog, does not count a scroll as consent, and sends only the displayed version and hash", async () => {
    const user = userEvent.setup();
    const longDocument = (element: HTMLElement) => element.getAttribute("aria-label") === "Service terms policy text";
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return longDocument(this) ? 200 : 0; });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return longDocument(this) ? 1000 : 0; });
    renderUi(<><h1>Dashboard</h1><PolicyAcceptanceWidget /></>);
    await user.click(await screen.findByRole("button", { name: "Review required policies" }));
    const dialog = screen.getByRole("dialog", { name: "Required policy review" });
    const review = within(dialog).getByRole("region", { name: "Service terms policy text" });
    await expectNoAxeViolations(window.document.body);
    const consent = within(dialog).getByRole("checkbox", { name: /I have read and agree/ });
    const accept = within(dialog).getByRole("button", { name: "Accept this version" });
    expect(consent).not.toBeChecked();
    expect(consent).toBeDisabled();
    expect(accept).toBeDisabled();
    fireEvent.scroll(review, { target: { scrollTop: 800 } });
    expect(consent).not.toBeDisabled();
    expect(accept).toBeDisabled();
    mocks.accept.mockImplementation(async () => {
      mocks.policyStatus.mockResolvedValue({ published: [document], pendingRequired: [], acceptances: [] });
      return { acceptancePublicId: publicId("A"), duplicate: false };
    });
    await user.click(consent);
    await user.click(accept);
    await waitFor(() => expect(mocks.accept.mock.calls.map(([input]) => input)).toEqual([{ versionPublicId: document.versionPublicId, contentHash: document.contentHash }]));
    expect(await within(dialog).findByText("The portal confirmed all required versions are accepted.")).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Review policy status" })).toHaveFocus());
  });

  it("blocks the order wizard until server status confirms all acceptances and requires an explicit typed name when configured", async () => {
    const user = userEvent.setup();
    const pending = { ...document, requiresTypedSignature: true };
    mocks.policyStatus.mockResolvedValue({ published: [pending], pendingRequired: [pending], acceptances: [] });
    const { queryClient } = renderUi(<RequiredPolicyGate><button>Start the wizard</button></RequiredPolicyGate>);
    expect(await screen.findByRole("heading", { name: "Review required policies" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start the wizard" })).not.toBeInTheDocument();
    const accept = screen.getByRole("button", { name: "Accept this version" });
    await user.click(screen.getByRole("checkbox"));
    expect(accept).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: /Type your full name/ }), "  Example Customer  ");
    await user.click(accept);
    await waitFor(() => expect(mocks.accept.mock.calls[0]?.[0]).toMatchObject({ signerName: "Example Customer", versionPublicId: pending.versionPublicId }));
    expect(screen.queryByRole("button", { name: "Start the wizard" })).not.toBeInTheDocument();
    mocks.policyStatus.mockResolvedValue({ published: [pending], pendingRequired: [], acceptances: [] });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["status"] }); });
    expect(await screen.findByRole("button", { name: "Start the wizard" })).toBeVisible();
  });

  it("does not trust cached cleared policy status after a failed fresh read", async () => {
    mocks.policyStatus.mockRejectedValueOnce(new Error("unavailable"));
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(["status", null], { pendingRequired: [], published: [], acceptances: [] });
    renderUi(<RequiredPolicyGate><button>Start the wizard</button></RequiredPolicyGate>, { queryClient });
    expect(await screen.findByText("We couldn't verify your policy status")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start the wizard" })).not.toBeInTheDocument();
  });

  it("hides a started wizard when new policy status requires acceptance without losing the draft", async () => {
    const user = userEvent.setup();
    mocks.policyStatus.mockResolvedValue({ pendingRequired: [], published: [document], acceptances: [] });
    const { queryClient } = renderUi(<RequiredPolicyGate><label>Project draft <input /></label></RequiredPolicyGate>);
    const draft = await screen.findByRole("textbox", { name: "Project draft" });
    await user.type(draft, "My project");
    mocks.policyStatus.mockResolvedValue({ pendingRequired: [document], published: [document], acceptances: [] });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["status"] }); });
    expect(await screen.findByRole("heading", { name: "Review required policies" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Project draft" })).not.toBeInTheDocument();
    mocks.policyStatus.mockResolvedValue({ pendingRequired: [], published: [document], acceptances: [] });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["status"] }); });
    expect(await screen.findByRole("textbox", { name: "Project draft" })).toHaveValue("My project");
  });

  it("keeps an h1 heading visible inside a local Suspense boundary while a lazy child page loads after policy check", async () => {
    mocks.policyStatus.mockResolvedValue({ pendingRequired: [], published: [document], acceptances: [] });
    let resolveLazy!: (mod: { default: () => ReactElement }) => void;
    const LazyChild = lazy(
      () =>
        new Promise<{ default: () => ReactElement }>((resolve) => {
          resolveLazy = resolve;
        }),
    );
    const { container } = renderUi(
      <Suspense fallback={<p>Outer route loading without heading</p>}>
        <RequiredPolicyGate>
          <LazyChild />
        </RequiredPolicyGate>
      </Suspense>,
    );
    await waitFor(() => expect(resolveLazy).toBeTypeOf("function"));
    expect(screen.getByRole("heading", { level: 1, name: "New order" })).toBeVisible();
    expect(screen.queryByText("Outer route loading without heading")).not.toBeInTheDocument();
    await expectNoAxeViolations(container);

    await act(async () => {
      resolveLazy({ default: () => <h1>New order wizard loaded</h1> });
    });
    expect(await screen.findByRole("heading", { level: 1, name: "New order wizard loaded" })).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it("renders legal markup as safe text and shows only server-returned acceptance history", async () => {
    const legal = renderUi(<LegalPage />);
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeVisible();
    expect(legal.container.querySelector("img")).toBeNull();
    expect(mocks.policyStatus).not.toHaveBeenCalled();
    await expectNoAxeViolations(legal.container);
    legal.unmount();
    mocks.policyStatus.mockResolvedValue({ published: [document], pendingRequired: [], acceptances: [{
      acceptancePublicId: publicId("A"), title: "Service terms", versionNumber: 1, versionLabel: "Prior terms",
      method: "registration", acceptedAt: date, origin: "portal",
    }] });
    renderUi(<MyPoliciesPage />);
    expect(await screen.findByText("1 · Prior terms")).toBeVisible();
    expect(screen.getByText("Account registration")).toBeVisible();
  });
});

describe("customer order intake", () => {
  it("renders published field controls and links required answers to errors without blocking draft saves", async () => {
    const user = userEvent.setup();
    const { container } = renderUi(<><h1>Order</h1><OrderIntakeTab orderId={orderId} area="customer" /></>);
    expect(await screen.findByRole("heading", { name: "Project brief" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Category" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Mix" })).toBeVisible();
    expect(screen.getByLabelText("Requested date")).toHaveAttribute("type", "date");
    await user.click(screen.getByRole("button", { name: "Submit questionnaire" }));
    const name = screen.getByRole("textbox", { name: /Project name/ });
    expect(name).toHaveAccessibleDescription("Answer this required question.");
    expect(name).toHaveFocus();
    expect(mocks.submit).not.toHaveBeenCalled();
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(mocks.save.mock.calls[0]?.[0]).toMatchObject({ answers: { name: null } }));
    expect(await screen.findByText("Draft saved.")).toBeVisible();
  });

  it("submits typed data and associates authoritative field failures with the matching input", async () => {
    const user = userEvent.setup();
    mocks.submit.mockRejectedValue({
      data: { safe: { domainCode: "VALIDATION", reasonCode: "INVALID_INTAKE_NUMBER", safeMessage: "Enter a supported track count.",
        details: { field: "count" }, requestId: "synthetic" } },
    });
    renderUi(<OrderIntakeTab orderId={orderId} area="customer" />);
    await user.type(await screen.findByRole("textbox", { name: /Project name/ }), "Studio work");
    const count = screen.getByRole("textbox", { name: "Track count" });
    await user.type(count, "2.5");
    await user.click(screen.getByRole("button", { name: "Submit questionnaire" }));
    expect(await screen.findByText("Enter a supported track count.", { selector: "[role=alert] div" })).toBeVisible();
    expect(count).toHaveFocus();
    expect(count).toHaveAccessibleDescription("Enter a supported track count.");
    expect(mocks.submit.mock.calls[0]?.[0]).toMatchObject({ orderPublicId: orderId, answers: { count: 2.5 } });
  });

  it("shows read-only answers and revision history while the order is locked", async () => {
    const user = userEvent.setup();
    const item = { ...intake, submission: { submissionPublicId: publicId("B"), status: "draft", revisionNumber: 1,
      answers: { name: "Saved title" }, latestReviewNote: null, submittedAt: null, reviewedAt: null, origin: "portal", updatedAt: date } };
    mocks.intakeList.mockResolvedValue({ lockState: "hard_locked", items: [item] });
    mocks.history.mockResolvedValue({ item, nextCursor: null, revisions: [{
      revisionPublicId: publicId("C"), revisionNumber: 1, eventKind: "draft_saved", actorRole: "customer", occurredAt: date,
      answers: { name: "Earlier title" }, reviewNote: null,
    }] });
    const { container } = renderUi(<><h1>Order</h1><OrderIntakeTab orderId={orderId} area="customer" /></>);
    expect(await screen.findByText("Saved title")).toBeVisible();
    expect(screen.getByText("This questionnaire is read-only while the order is locked.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save draft" })).not.toBeInTheDocument();
    expect(mocks.history).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Show revision history" }));
    await user.click(await screen.findByText("Answers in revision 1"));
    expect(screen.getByText("Earlier title")).toBeVisible();
    await expectNoAxeViolations(container);
  });
});

describe("customer invoices", () => {
  it("shows invoices and money on the listing and order tab without exposing unissued invoices", async () => {
    const draft = { ...invoice, invoicePublicId: publicId("D"), invoiceNumber: "Unissued sample", issuedAt: null, status: "draft" };
    mocks.invoiceList.mockResolvedValue({ items: [invoice, draft], nextCursor: null });
    mocks.orderInvoices.mockResolvedValue({ items: [invoice, draft] });
    const list = renderUi(<InvoicesPage />);
    const invoiceLink = await screen.findByRole("link", { name: "RP-INV-123" });
    expect(invoiceLink).toHaveAttribute("href", `/invoices/${invoice.invoicePublicId}`);
    expect(invoiceLink).toHaveClass("inline-flex", "min-h-6", "items-center");
    expect(screen.getByText("Issued")).toBeVisible();
    expect(screen.getByText("Due date")).toBeVisible();
    expect(screen.getByText("$70.00")).toBeVisible();
    expect(screen.queryByText("Unissued sample")).not.toBeInTheDocument();
    await expectNoAxeViolations(list.container);
    list.unmount();
    renderUi(<OrderInvoicesTab orderId={orderId} area="customer" />);
    expect(await screen.findByRole("link", { name: "RP-INV-123" })).toHaveAttribute("href", `/invoices/${invoice.invoicePublicId}`);
    expect(screen.queryByRole("link", { name: "New invoice for this order" })).not.toBeInTheDocument();
    expect(screen.queryByText("Unissued sample")).not.toBeInTheDocument();
    expect(mocks.orderInvoices).toHaveBeenCalledWith({ orderPublicId: orderId });
  });

  it("presents lines and payment/refund evidence, requests the private PDF, and offers no payment CTA", async () => {
    const user = userEvent.setup();
    mocks.fetch.mockResolvedValue(new Response(null, { status: 403 }));
    const { container } = renderUi(<Route path="/invoices/:invoiceId"><InvoiceDetailPage /></Route>, { path: `/invoices/${invoice.invoicePublicId}` });
    expect(await screen.findByRole("heading", { name: "RP-INV-123" })).toBeVisible();
    expect(screen.getByText("Mixing")).toBeVisible();
    expect(screen.getByText("Wire ABC")).toBeVisible();
    expect(screen.getByText("Refund ABC")).toBeVisible();
    expect(screen.getByText("Outstanding balance")).toBeVisible();
    expect(screen.getByText("Online payment is not available.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Contact us" })).toHaveAttribute("href", "/support");
    expect(screen.queryByRole("button", { name: /pay now/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Download PDF" }));
    expect(await screen.findByText("We couldn’t download this PDF.", { exact: false })).toBeVisible();
    expect(mocks.fetch).toHaveBeenCalledWith(expect.stringContaining(`/api/compliance/invoices/${invoice.invoicePublicId}/pdf`), { method: "GET" });
    await expectNoAxeViolations(container);
  });

  it("downloads a successful PDF with a local filename and releases the temporary object URL", async () => {
    const user = userEvent.setup();
    const objectUrl = vi.fn(() => "blob:synthetic-invoice");
    const revokeUrl = vi.fn();
    vi.stubGlobal("URL", class extends URL {
      static override createObjectURL = objectUrl;
      static override revokeObjectURL = revokeUrl;
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("RP-INV-123.pdf");
      expect(this.href).toBe("blob:synthetic-invoice");
    });
    mocks.fetch.mockResolvedValue(new Response("%PDF-1.4\nsynthetic invoice", { headers: { "Content-Type": "application/pdf" } }));
    renderUi(<Route path="/invoices/:invoiceId"><InvoiceDetailPage /></Route>, { path: `/invoices/${invoice.invoicePublicId}` });
    await user.click(await screen.findByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(objectUrl).toHaveBeenCalledOnce();
    expect(revokeUrl).toHaveBeenCalledWith("blob:synthetic-invoice");
  });

  it("renders customer payment receipts with refund notes and hides order receipts for non-billing collaborators", async () => {
    const user = userEvent.setup();
    const receiptId = publicId("C");
    const noteId = publicId("D");
    const sampleReceipt = {
      receiptPublicId: receiptId,
      receiptNumber: "RPR-2026-000001",
      settlementKind: "provider_online" as const,
      invoicePublicId: invoice.invoicePublicId,
      paymentPublicId: publicId("8"),
      orderPublicId: orderId,
      orderReference: "RP-123",
      customerRef: "CUST-1",
      currency: "USD",
      subtotalMinor: 10000,
      discountMinor: 0,
      bundleDiscountMinor: 0,
      promoDiscountMinor: 0,
      promoLabel: null,
      taxMinor: 0,
      amountWaivedMinor: 0,
      amountPaidMinor: 10000,
      refundedMinor: 1000,
      refundState: "partially_refunded" as const,
      paymentMethod: "provider_online" as const,
      paymentMethodBrand: "visa",
      paymentMethodLast4: "4242",
      paymentMethodSummary: "Visa ending in 4242",
      provider: "stripe",
      issuedAt: date,
      origin: "portal" as const,
      refundNotes: [
        {
          notePublicId: noteId,
          noteNumber: "RPRN-2026-000001",
          receiptPublicId: receiptId,
          refundPublicId: publicId("9"),
          orderPublicId: orderId,
          currency: "USD",
          refundAmountMinor: 1000,
          cumulativeRefundedMinor: 1000,
          resultingRefundState: "partially_refunded" as const,
          reasonCode: "ADJUSTMENT",
          reference: "Refund ABC",
          issuedAt: date,
        },
      ],
    };
    mocks.receiptList.mockResolvedValue({ items: [sampleReceipt], nextCursor: null });

    const { container, unmount } = renderUi(<InvoicesPage />, { path: "/invoices" });
    await user.click(await screen.findByRole("tab", { name: "Receipts" }));
    expect(await screen.findByRole("link", { name: "RPR-2026-000001" })).toHaveAttribute("href", `/receipts/${receiptId}`);
    expect(screen.getByText("Visa ending in 4242")).toBeVisible();
    expect(screen.getByText("RPRN-2026-000001")).toBeVisible();
    await expectNoAxeViolations(container);
    unmount();

    // Non-billing collaborator receiving FORBIDDEN sees invoices cleanly without receipt leakage or error crash.
    mocks.orderReceipts.mockRejectedValue({
      message: "Receipts are available only to the buyer.",
      data: { safe: { message: "Receipts are available only to the buyer.", domainCode: "FORBIDDEN", reasonCode: "NOT_RECEIPT_BUYER_OR_BILLING" } },
    });
    renderUi(<OrderInvoicesTab orderId={orderId} area="customer" />);
    expect(await screen.findByRole("link", { name: "RP-INV-123" })).toBeVisible();
    expect(screen.queryByText("Payment receipts")).not.toBeInTheDocument();
  });

  it("shows expected account name and link to /account on SIGNER_NAME_MISMATCH", async () => {
    const user = userEvent.setup();
    const pending = { ...document, requiresTypedSignature: true };
    mocks.policyStatus.mockResolvedValue({
      published: [pending],
      pendingRequired: [pending],
      acceptances: [],
      expectedSignerName: "Ada Lovelace",
    });
    mocks.accept.mockRejectedValue({
      message: "Typed signature must match your account name.",
      data: {
        safe: {
          message: "Typed signature must match your account name.",
          domainCode: "VALIDATION_ERROR",
          reasonCode: "SIGNER_NAME_MISMATCH",
          details: { expectedName: "Ada Lovelace" },
        },
      },
    });
    renderUi(<RequiredPolicyGate><button>Start the wizard</button></RequiredPolicyGate>);
    expect(await screen.findByText(/Expected account name: Ada Lovelace/)).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: /I have read and agree/ }));
    await user.type(screen.getByLabelText(/Type your full name to sign/), "Grace Hopper");
    await user.click(screen.getByRole("button", { name: "Accept this version" }));
    const profileLink = await screen.findByRole("link", { name: "Update your profile name" });
    expect(profileLink).toHaveAttribute("href", "/account");
  });
});
