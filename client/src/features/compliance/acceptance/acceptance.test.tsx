/**
 * Package V client: customer gate, console Acceptances tab (+ label), printable receipt.
 * Fixture-backed tRPC; synthetic data. Axe light + dark via pageA11y.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { AppRoutes } from "@/app/AppRouter";
import { pageA11y } from "@/test/a11y";
import { PageHeader } from "@/ui";
import AcceptanceGate from "./AcceptanceGate";
import AcceptancesTab, { AcceptancesTabLabel } from "./AcceptancesTab";
import { acceptanceRoutes } from "./index";
import { renderWithTrpc, type Fixtures, type Role } from "./testkit";

const orderId = "01JD0000000000000000000010";
const receiptId = "01JD0000000000000000000501";
const hash = "a".repeat(64);
const when = new Date("2026-11-21T15:30:00.000Z").toISOString();

const policy = (title = "Production terms") => ({
  id: "01JD0000000000000000000401", title, versionId: "01JD0000000000000000000402", versionNumber: 2, versionLabel: "2.0",
  contentFormat: "plain_text" as const, text: "You agree to the synthetic production terms.\n\nSecond paragraph.", textSha256: hash,
});
const gate = (patch: Record<string, unknown> = {}) => ({
  key: "terms", point: { kind: "order_start" }, signatureMode: "checkbox", askAgainOnNewVersion: false, applies: true, required: true, met: false, acceptance: null, policy: policy(), ...patch,
});
const receipt = {
  receiptId, order: { id: orderId, reference: "RP-1042", name: "Spring catalogue" }, policy: { id: "01JD0000000000000000000401", title: "Production terms", versionNumber: 2, versionLabel: "2.0" },
  gateKey: "order_start", textSha256: hash, signatureMode: "typed_name", typedName: "Cara Customer", signerName: "Cara Customer", acceptedAt: when,
};
const listItem = (patch: Record<string, unknown> = {}) => ({ ...receipt, signerRole: "owner", userAgent: "Safari", sourceAddress: null, ...patch });

/** Minimal stand-in for the app shell around the order page: one main landmark, a page title, one h1. */
function Host({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    document.title = "Order RP-1042 · ReadyPackets";
  }, []);
  return (
    <main className="flex flex-col gap-6">
      <PageHeader title="Order RP-1042" />
      {children}
    </main>
  );
}

const renderGate = (fixtures: Fixtures, area: "customer" | "console" = "customer") =>
  renderWithTrpc(<Host><AcceptanceGate orderId={orderId} area={area} /></Host>, fixtures, { role: area === "customer" ? "customer" : "admin" });
const renderTab = (fixtures: Fixtures, role: Role = "admin") =>
  renderWithTrpc(<Host><AcceptancesTab orderId={orderId} area="console" /></Host>, fixtures, { role });

describe("customer acceptance gate", () => {
  it("shows the policy text, needs the checkbox, and submits bound to the version and text hash", async () => {
    let accepted = false;
    const { calls } = renderGate({
      "compliance.acceptance.forOrder": () => ({ orderId, blocking: !accepted, gates: [accepted ? gate({ met: true, acceptance: { receiptId, acceptedAt: when, versionNumber: 2 } }) : gate()] }),
      "compliance.acceptance.accept": () => { accepted = true; return { duplicate: false, receipt }; },
    });
    expect(await screen.findByRole("heading", { name: "Please review and accept before you continue" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Production terms, full text" })).toHaveTextContent("synthetic production terms");
    const submit = screen.getByRole("button", { name: "Accept" });
    expect(submit).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /I have read and agree to Production terms/ }));
    await userEvent.click(submit);
    await waitFor(() => expect(calls.find((c) => c.path === "compliance.acceptance.accept")?.input).toEqual({ orderId, gateKey: "terms", policyVersionId: policy().versionId, textSha256: hash }));
    expect(await screen.findByRole("link", { name: "Production terms receipt" })).toHaveAttribute("href", `/acceptance-receipts/${receiptId}`);
    // Focus moves to the confirmation once the form unmounts, instead of falling back to <body>.
    await waitFor(() => expect(document.activeElement).toHaveTextContent("Policies accepted for this order:"));
  });

  it("typed signature: requires a typed name and sends it", async () => {
    const { calls } = renderGate({
      "compliance.acceptance.forOrder": () => ({ orderId, blocking: true, gates: [gate({ signatureMode: "typed_name" })] }),
      "compliance.acceptance.accept": () => ({ duplicate: false, receipt }),
    });
    const submit = await screen.findByRole("button", { name: "Sign and accept" });
    // Keyboard order: policy text region > typed name > checkbox > submit.
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Production terms, full text" }));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByLabelText(/Type your full name to sign/));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("checkbox"));
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Type your full name to sign/), "Cara Customer");
    await userEvent.click(submit);
    await waitFor(() => expect((calls.find((c) => c.path === "compliance.acceptance.accept")?.input as { typedName?: string })?.typedName).toBe("Cara Customer"));
  });

  it("explains a changed policy text (server refusal) in an alert", async () => {
    renderGate({
      "compliance.acceptance.forOrder": () => ({ orderId, blocking: true, gates: [gate()] }),
      "compliance.acceptance.accept": () => { throw { safe: { code: "CONFLICT", reasonCode: "POLICY_TEXT_CHANGED", safeMessage: "The policy was updated. Please read the current text and accept again." } }; },
    });
    await userEvent.click(await screen.findByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    const form = screen.getByRole("form", { name: "Accept Production terms" });
    expect(await within(form).findByRole("alert")).toHaveTextContent("The policy was updated");
  });

  it("after signing one of two gates, focus moves to the next policy text; a version conflict keeps its message on the new text", async () => {
    let first = false;
    let version = "01JD0000000000000000000402";
    const second = () => gate({ key: "privacy", policy: { ...policy("Privacy notice"), id: "01JD0000000000000000000411", versionId: version } });
    renderGate({
      "compliance.acceptance.forOrder": () => ({ orderId, blocking: true, gates: [first ? gate({ met: true, acceptance: { receiptId, acceptedAt: when, versionNumber: 2 } }) : gate(), second()] }),
      "compliance.acceptance.accept": (input) => {
        if ((input as { gateKey: string }).gateKey === "terms") { first = true; return { duplicate: false, receipt }; }
        version = "01JD0000000000000000000499";
        throw { safe: { code: "CONFLICT", reasonCode: "POLICY_TEXT_CHANGED", safeMessage: "The policy was updated. Please read the current text and accept again." } };
      },
    });
    const termsForm = await screen.findByRole("form", { name: "Accept Production terms" });
    await userEvent.click(within(termsForm).getByRole("checkbox"));
    await userEvent.click(within(termsForm).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Privacy notice, full text" })));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Accept Production terms" })).toBeNull());
    const privacyForm = screen.getByRole("form", { name: "Accept Privacy notice" });
    await userEvent.click(within(privacyForm).getByRole("checkbox"));
    await userEvent.click(within(privacyForm).getByRole("button", { name: "Accept" }));
    // The refetch re-keys the form (new version); the message and focus survive the remount.
    await waitFor(() => expect(within(screen.getByRole("form", { name: "Accept Privacy notice" })).getByRole("alert")).toHaveTextContent("The policy was updated"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "Privacy notice, full text" })));
    expect(within(screen.getByRole("form", { name: "Accept Privacy notice" })).getByRole("checkbox")).not.toBeChecked();
  });

  it("renders nothing in the console, without gates, and a notice when the policy isn't published", async () => {
    const { container, calls } = renderGate({ "compliance.acceptance.forOrder": () => ({ orderId, blocking: true, gates: [gate()] }) }, "console");
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(0);
    expect(container.querySelector("form")).toBeNull();
  });

  it("an unpublished policy shows a support notice instead of a form", async () => {
    renderGate({ "compliance.acceptance.forOrder": () => ({ orderId, blocking: true, gates: [gate({ policy: null })] }) });
    expect(await screen.findByText("A required policy isn't available")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });
});

describe("console Acceptances tab", () => {
  const fixtures = (sourceAddress: string | null): Fixtures => ({
    "compliance.acceptance.console.list": () => ({ total: 2, items: [listItem({ sourceAddress }), listItem({ receiptId: "01JD0000000000000000000502", signatureMode: "checkbox", typedName: null, signerName: "Gus Grantee", signerRole: "grantee", sourceAddress })], nextCursor: null }),
    "compliance.acceptance.console.count": () => ({ total: 2 }),
  });

  it("lists signatures with roles and receipt links; source address column for administrators", async () => {
    renderTab(fixtures("198.51.100.23"), "admin");
    expect((await screen.findAllByText("Signed by Cara Customer using typed signature")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Accepted by Gus Grantee using checkbox").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Person with access").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Source address").length).toBeGreaterThan(0);
    expect(screen.getAllByText("198.51.100.23").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /Receipt for Signed by Cara Customer/ })[0]).toHaveAttribute("href", `/admin/acceptance-receipts/${receiptId}`);
  });

  it("staff without sessions.read_all get no source address column", async () => {
    renderTab(fixtures(null), "staff");
    await screen.findAllByText("Signed by Cara Customer using typed signature");
    expect(screen.queryByText("Source address")).toBeNull();
  });

  it("label shows the count in the console", async () => {
    renderWithTrpc(<AcceptancesTabLabel orderId={orderId} area="console" />, fixtures(null));
    expect(await screen.findByText("Acceptances (2)")).toBeInTheDocument();
  });
});

describe("acceptance receipt", () => {
  it("customer receipt shows the evidence and a print button", async () => {
    renderWithTrpc(<AppRoutes routes={acceptanceRoutes} />, { "compliance.acceptance.receipt": () => receipt }, { path: `/acceptance-receipts/${receiptId}`, role: "customer" });
    expect(await screen.findByRole("heading", { level: 1, name: "Policy acceptance receipt" })).toBeInTheDocument();
    expect(await screen.findByText("Typed name: Cara Customer")).toBeInTheDocument();
    expect(screen.getByText(hash)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Back to order" })).toHaveAttribute("href", `/orders/${orderId}`);
  });
});

pageA11y("acceptance gate (customer) ready", async () => {
  renderGate({ "compliance.acceptance.forOrder": () => ({ orderId, blocking: true, gates: [gate({ signatureMode: "typed_name" })] }) });
  await screen.findByRole("button", { name: "Sign and accept" });
});
pageA11y("Acceptances tab ready", async () => {
  renderTab({ "compliance.acceptance.console.list": () => ({ total: 1, items: [listItem({ sourceAddress: "198.51.100.23" })], nextCursor: null }) });
  await screen.findAllByText("Signed by Cara Customer using typed signature");
});
pageA11y("/acceptance-receipts/:id (customer) ready", async () => {
  renderWithTrpc(<AppRoutes routes={acceptanceRoutes} />, { "compliance.acceptance.receipt": () => receipt }, { path: `/acceptance-receipts/${receiptId}`, role: "customer" });
  await screen.findByText("Typed name: Cara Customer");
});
pageA11y("/admin/acceptance-receipts/:id ready", async () => {
  renderWithTrpc(<AppRoutes routes={acceptanceRoutes} />, { "compliance.acceptance.receipt": () => receipt }, { path: `/admin/acceptance-receipts/${receiptId}`, role: "admin" });
  await screen.findByText("Typed name: Cara Customer");
});
