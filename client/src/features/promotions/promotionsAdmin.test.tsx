import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Switch } from "wouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as trpcModule from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { renderUi } from "@/ui/testing";
import DiscountCodesPage from "./DiscountCodesPage";
import {
  discountSummary, emptyForm, formFromView, parseMoney, toUpdateInput, validateForm, type PromotionStats, type PromotionView, type RedemptionView,
} from "./model";
import PromotionDetailPage from "./PromotionDetailPage";
import PromotionEditorPage from "./PromotionEditorPage";
import RedemptionsPage from "./RedemptionsPage";
import { promotionsFeature } from "./routes";

/* ---- tRPC mock: every procedure path resolves through `handlers[path]` ---- */
const { handlers, calls, session } = vi.hoisted(() => ({
  handlers: {} as Record<string, (input: unknown) => unknown>,
  calls: [] as Array<{ path: string; input: unknown }>,
  session: { role: "admin" as string },
}));
vi.mock("@/lib/session", () => ({ useSession: () => ({ me: { state: "full", user: { role: session.role } }, view: { status: "full", role: session.role } }) }));
vi.mock("@/lib/trpc", async (original) => {
  const call = (path: string, input: unknown) => {
    calls.push({ path, input });
    const handler = handlers[path];
    if (!handler) return Promise.reject(new Error(`unmocked ${path}`));
    try { return Promise.resolve(handler(input)); } catch (e) { return Promise.reject(e); }
  };
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        const key = path.join(".");
        if (prop === "queryOptions") return (input?: unknown) => ({ queryKey: [key, input ?? null], queryFn: () => call(key, input) });
        if (prop === "infiniteQueryOptions") return (input: Record<string, unknown>, opts: { getNextPageParam: (last: unknown) => unknown }) => ({
          queryKey: [key, input, "infinite"], initialPageParam: null, getNextPageParam: opts.getNextPageParam,
          queryFn: ({ pageParam }: { pageParam: unknown }) => call(key, { ...input, cursor: pageParam }),
        });
        if (prop === "mutationOptions") return () => ({ mutationFn: (input: unknown) => call(key, input) });
        if (prop === "pathFilter" || prop === "queryFilter") return () => ({ queryKey: [key] });
        if (prop === "queryKey" || prop === "pathKey") return () => [key];
        return node([...path, prop]);
      },
    });
  return { ...await original<typeof trpcModule>(), useTRPC: () => node([]), useTRPCClient: () => node([]) };
});

const P = "promotions.admin";
const trpcError = (domainCode: string, reasonCode: string, safeMessage: string) => Object.assign(new Error(reasonCode), { data: { safe: { domainCode, reasonCode, safeMessage, requestId: "r" } } });

const single: PromotionView = {
  publicId: "pr_synthetic_0001", name: "Spring campaign", label: "Spring offer", type: "percent", percentBps: 1500, maxDiscountMinor: 2500, amountMinor: null, currency: "USD",
  scope: { kind: "all" }, minSubtotalMinor: 5000, startsAt: null, endsAt: "2026-12-31T23:00:00.000Z", maxRedemptions: 100, maxPerCustomer: 1, firstOrderOnly: false,
  allowCustomerPublicIds: [], allowEmailDomains: [], combineWithBundle: false, status: "active", derivedStatus: "active", isBatch: false, codePrefix: null, batchSize: 1,
  redemptionCount: 3, codeMasked: "SP••••24", note: null, version: 4, createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z",
};
const batch: PromotionView = { ...single, publicId: "pr_synthetic_0002", name: "Partner batch", label: "Partner offer", type: "fixed", percentBps: null, maxDiscountMinor: null, amountMinor: 1000, isBatch: true, codePrefix: "PARTNER", batchSize: 250, codeMasked: "PARTNER-••••", status: "paused", derivedStatus: "paused", version: 2 };
const redemption: RedemptionView = {
  publicId: "rd_synthetic_0001", promoPublicId: single.publicId, promotionPublicId: single.publicId, promotionName: single.name, label: single.label, promotionLabel: single.label,
  customerPublicId: "us_synthetic_0001", customerRef: null, bundleDiscountMinor: 0, discountMinor: 1500, createdAt: "2026-11-10T10:00:00.000Z", releaseReason: null, releaseNote: null, codeMasked: "SP••••24", orderPublicId: "or_synthetic_0001", orderNumber: "RP-1001",
  status: "redeemed", currency: "USD", subtotalMinor: 10000, promoDiscountMinor: 1500, totalMinor: 8500, redeemedAt: "2026-11-10T10:00:00.000Z", releasedAt: null,
};
const stats: PromotionStats = { activePromotions: 1, redemptions: 3, releasedRedemptions: 1, discountMinorByCurrency: { USD: 4500, EUR: 900 } };

function defaults() {
  for (const k of Object.keys(handlers)) delete handlers[k];
  calls.length = 0;
  handlers[`${P}.list`] = () => ({ items: [single, batch], nextCursor: null });
  handlers[`${P}.get`] = (input) => ((input as { publicId: string }).publicId === batch.publicId ? batch : single);
  handlers[`${P}.stats`] = () => stats;
  handlers[`${P}.getSettings`] = () => ({ enabled: true, maxDiscountPercent: 50 });
  handlers[`${P}.redemptions`] = () => ({ items: [redemption], nextCursor: null });
  handlers[`${P}.pause`] = () => ({ ...single, status: "paused", derivedStatus: "paused", version: 5 });
  handlers[`${P}.revoke`] = () => ({ ...single, status: "revoked", derivedStatus: "revoked", version: 5 });
}
beforeEach(() => { session.role = "admin"; defaults(); });
afterEach(() => vi.restoreAllMocks());
const callsTo = (name: string) => calls.filter((c) => c.path === `${P}.${name}`).map((c) => c.input);

function page(path: string, title: string) {
  document.title = title;
  return renderUi(
    <main id="main">
      <Switch>
        <Route path="/admin/promotions" component={DiscountCodesPage} />
        <Route path="/admin/promotions/new" component={PromotionEditorPage} />
        <Route path="/admin/promotions/redemptions" component={RedemptionsPage} />
        <Route path="/admin/promotions/:promotionId/edit" component={PromotionEditorPage} />
        <Route path="/admin/promotions/:promotionId" component={PromotionDetailPage} />
      </Switch>
    </main>,
    { path },
  );
}

describe("model", () => {
  it("validates every D3 control with specific messages and builds the server input", () => {
    const f = { ...emptyForm(), name: "Spring", label: "Spring offer", percent: "60", code: "-BAD" };
    const { errors } = validateForm(f, { creating: true, maxDiscountPercent: 50 });
    expect(errors.percent).toMatch(/largest discount per order is 50 %/u);
    expect(errors.code).toMatch(/6 to 32/u);
    const ok = validateForm({ ...f, percent: "15", maxDiscount: "25.00", minSubtotal: "50", code: "SPRING-24", allowDomains: ["example.com"], scopeKind: "packets", scopePackets: ["25", "50"] }, { creating: true, maxDiscountPercent: 50 });
    expect(ok.errors).toEqual({});
    expect(ok.input).toMatchObject({ type: "percent", percentBps: 1500, maxDiscountMinor: 2500, minSubtotalMinor: 5000, code: "SPRING-24", scope: { kind: "packets", packetNumbers: [25, 50] }, maxPerCustomer: 1 });
  });
  it("refuses a label equal to the code, bad domains, end before start, and batch bounds", () => {
    const base = { ...emptyForm(), name: "N", label: "SPRING-24", percent: "10", code: "SPRING-24" };
    expect(validateForm(base, { creating: true }).errors.label).toMatch(/must not be the code/u);
    expect(validateForm({ ...base, label: "L", allowDomains: ["not a domain"] }, { creating: true }).errors.allowDomains).toBeTruthy();
    expect(validateForm({ ...base, label: "L", startsAt: "2026-12-02T10:00", endsAt: "2026-12-01T10:00" }, { creating: true }).errors.endsAt).toMatch(/after the start/u);
    const b = { ...base, label: "L", codeMode: "batch" as const, batchCount: "5001", batchPrefix: "BAD-PREFIX" };
    const e = validateForm(b, { creating: true }).errors;
    expect(e.batchCount).toMatch(/1 to 5,000/u);
    expect(e.batchPrefix).toMatch(/1 to 12 letters or digits/u);
    const good = validateForm({ ...b, batchCount: "5000", batchPrefix: "PARTNER" }, { creating: true });
    expect(good.input).toMatchObject({ isBatch: true, codePrefix: "PARTNER", initialBatchCount: 5000 });
    expect((good.input as { idempotencyKey: string }).idempotencyKey).toMatch(/^[0-9a-f]{32}$/u);
  });
  it("edit round-trips a view and the update input never carries type, amount or currency", () => {
    const { input } = validateForm(formFromView(single), { creating: false });
    expect(input).not.toBeNull();
    const upd = toUpdateInput(input!, single);
    expect(upd).toMatchObject({ publicId: single.publicId, expectedVersion: 4, maxDiscountMinor: 2500, minSubtotalMinor: 5000, scope: { kind: "all" } });
    for (const k of ["type", "percentBps", "amountMinor", "currency", "code", "isBatch"]) expect(upd).not.toHaveProperty(k);
  });
  it("parses money exactly and summarises discounts", () => {
    expect(parseMoney("12.5", "USD")).toBe(1250);
    expect(parseMoney("", "USD")).toBeNull();
    expect(parseMoney("1.234", "USD")).toBeNaN();
    expect(discountSummary(single)).toBe("15 % off, up to $25.00");
    expect(discountSummary(batch)).toBe("$10.00 off");
  });
});

describe("routes", () => {
  it("registers the landing, staff-readable pages and manage-only editors; nav is not hidden by the switch", () => {
    const byPath = Object.fromEntries(promotionsFeature.routes.map((r) => [r.path, r]));
    expect(byPath["/promo"]?.access).toBe("public");
    expect(byPath["/admin/promotions"]).toMatchObject({ access: "staff", capability: "promotions.read" });
    expect(byPath["/admin/promotions/new"]).toMatchObject({ access: "admin", capability: "promotions.manage" });
    expect(byPath["/admin/promotions/:promotionId/edit"]).toMatchObject({ capability: "promotions.manage" });
    const paths = promotionsFeature.routes.map((r) => r.path);
    expect(paths.indexOf("/admin/promotions/redemptions")).toBeLessThan(paths.indexOf("/admin/promotions/:promotionId"));
    expect(promotionsFeature.nav?.[0]).toMatchObject({ href: "/admin/promotions", capability: "promotions.read" });
    expect(promotionsFeature.nav?.[0]?.enabledBy).toBeUndefined();
  });
});

describe("Discount codes list", () => {
  it("shows totals per currency, masked codes, text statuses and passes filters to the server", async () => {
    const user = userEvent.setup();
    page("/admin/promotions", "Discount codes");
    expect(await screen.findAllByText("Spring campaign")).not.toHaveLength(0);
    expect(screen.getAllByText("SP••••24").length).toBeGreaterThan(0);
    expect(screen.getAllByText("250 single-use codes").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Paused").length).toBeGreaterThan(0);
    expect(screen.getByText("$45.00")).toBeTruthy();
    expect(screen.getByText("€9.00")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SPRING-24");
    await user.selectOptions(screen.getAllByLabelText("Status")[0]!, "scheduled");
    await waitFor(() => expect(callsTo("list").some((i) => (i as { status?: string }).status === "scheduled")).toBe(true));
  });

  it("staff (promotions.read only) see no create, status or settings controls", async () => {
    session.role = "staff";
    page("/admin/promotions", "Discount codes");
    await screen.findAllByText("Spring campaign");
    expect(screen.queryByRole("link", { name: "New discount code" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Pause /u })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("pause asks for confirmation, sends the expected version; the swapped row lands focus on its next action (Resume)", async () => {
    const user = userEvent.setup();
    const paused = { ...single, status: "paused" as const, derivedStatus: "paused" as const, version: 5 };
    let current = single;
    handlers[`${P}.list`] = () => ({ items: [current, batch], nextCursor: null });
    handlers[`${P}.pause`] = () => { current = paused; return paused; };
    page("/admin/promotions", "Discount codes");
    await user.click((await screen.findAllByRole("button", { name: "Pause Spring campaign" }))[0]!);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Orders already placed keep their discount/u)).toBeTruthy();
    await user.keyboard("{Tab}");
    await user.click(within(dialog).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(callsTo("pause")).toEqual([{ publicId: single.publicId, expectedVersion: 4 }]));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Resume Spring campaign"));
  });

  it("when the changed row leaves a filtered list, focus lands on the results heading", async () => {
    const user = userEvent.setup();
    let gone = false;
    handlers[`${P}.list`] = () => ({ items: gone ? [batch] : [single, batch], nextCursor: null });
    handlers[`${P}.revoke`] = () => { gone = true; return { ...single, status: "revoked", derivedStatus: "revoked", version: 5 }; };
    page("/admin/promotions", "Discount codes");
    await user.click((await screen.findAllByRole("button", { name: "Revoke Spring campaign" }))[0]!);
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Codes" })));
  });

  it("revoke is destructive (Cancel focused first) and calls nothing when cancelled", async () => {
    const user = userEvent.setup();
    page("/admin/promotions", "Discount codes");
    await user.click((await screen.findAllByRole("button", { name: "Revoke Spring campaign" }))[0]!);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/permanent/u)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })));
    await user.keyboard("{Escape}");
    expect(callsTo("revoke")).toEqual([]);
  });

  it("largest discount per order: validated, then saved", async () => {
    const user = userEvent.setup();
    handlers[`${P}.updateSettings`] = (i) => ({ enabled: true, ...(i as object) });
    page("/admin/promotions", "Discount codes");
    const input = await screen.findByLabelText("Largest discount per order (%)");
    await user.clear(input);
    await user.type(input, "150{Enter}");
    // Enter inside the focused field: the error is linked and also announced politely.
    await waitFor(() => expect(screen.getAllByRole("status").some((r) => r.textContent === "Enter a whole percentage from 1 to 100.")).toBe(true));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    // Button activation: focus moves to the invalid field.
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(callsTo("updateSettings")).toEqual([]);
    await user.clear(input);
    await user.type(input, "40{Enter}");
    await waitFor(() => expect(callsTo("updateSettings")).toEqual([{ maxDiscountPercent: 40 }]));
  });

  pageA11y("/admin/promotions", async () => {
    page("/admin/promotions", "Discount codes");
    await screen.findAllByText("Spring campaign");
  });
  pageA11y("/admin/promotions revoke dialog", async () => {
    const user = userEvent.setup();
    page("/admin/promotions", "Discount codes");
    await user.click((await screen.findAllByRole("button", { name: "Revoke Spring campaign" }))[0]!);
    await screen.findByRole("alertdialog");
  });
});

describe("Create / edit form", () => {
  it("an empty submit focuses a linked error summary; each entry focuses its field", async () => {
    const user = userEvent.setup();
    page("/admin/promotions/new", "New discount code");
    await user.click(await screen.findByRole("button", { name: "Create discount code" }));
    const summary = await screen.findByText(/^Check \d+ fields$/u);
    await waitFor(() => expect(document.activeElement?.contains(summary)).toBe(true));
    await user.click(screen.getByRole("button", { name: "Enter an internal name." }));
    expect(document.activeElement).toBe(screen.getByLabelText(/^Internal name/u));
    expect(screen.getByLabelText(/^Internal name/u).getAttribute("aria-invalid")).toBe("true");
    expect(callsTo("create")).toEqual([]);
  });

  it("creates a chosen code, then shows it masked with copy code / copy link (fragment link)", async () => {
    const user = userEvent.setup();
    handlers[`${P}.create`] = () => ({ promotion: single, initialCode: "SPRING-24", generatedCount: 0 });
    page("/admin/promotions/new", "New discount code");
    await user.type(await screen.findByLabelText(/^Internal name/u), "Spring campaign");
    await user.type(screen.getByLabelText(/^Label customers see/u), "Spring offer");
    await user.type(screen.getByLabelText(/^Percentage off/u), "15");
    await user.type(screen.getByLabelText(/^Code/u), "spring-24");
    screen.getByRole("button", { name: "Create discount code" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(callsTo("create")).toHaveLength(1));
    expect(callsTo("create")[0]).toMatchObject({ name: "Spring campaign", label: "Spring offer", type: "percent", percentBps: 1500, code: "SPRING-24", scope: { kind: "all" } });
    const result = await screen.findByText('"Spring campaign" created');
    await waitFor(() => expect(document.activeElement?.contains(result)).toBe(true));
    expect(document.activeElement?.textContent).not.toContain("SPRING-24");
    expect(screen.getByRole("button", { name: "Copy link for Spring campaign" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy code for Spring campaign/u })).toBeTruthy();
  });

  it("maps LABEL_MATCHES_CODE onto the label field", async () => {
    const user = userEvent.setup();
    handlers[`${P}.create`] = () => { throw trpcError("VALIDATION", "LABEL_MATCHES_CODE", "The customer-facing label must not match the promotion code."); };
    page("/admin/promotions/new", "New discount code");
    await user.type(await screen.findByLabelText(/^Internal name/u), "N");
    await user.type(screen.getByLabelText(/^Label customers see/u), "Offer");
    await user.type(screen.getByLabelText(/^Percentage off/u), "10");
    await user.type(screen.getByLabelText(/^Code/u), "OFFER-2026");
    await user.click(screen.getByRole("button", { name: "Create discount code" }));
    expect(await screen.findByText("The customer-facing label must not match the promotion code.")).toBeTruthy();
    expect(screen.getAllByText("The label customers see must not be the code itself.").length).toBeGreaterThan(0);
  });

  it("edit locks type, amount and currency and sends only editable fields with the version", async () => {
    const user = userEvent.setup();
    handlers[`${P}.update`] = () => single;
    page(`/admin/promotions/${single.publicId}/edit`, "Edit discount code");
    const pct = await screen.findByLabelText(/^Percentage off/u);
    expect((pct as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: "Fixed amount" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByLabelText(/^Code/u)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(callsTo("update")).toHaveLength(1));
    expect(callsTo("update")[0]).toMatchObject({ publicId: single.publicId, expectedVersion: 4 });
    expect(callsTo("update")[0]).not.toHaveProperty("type");
  });

  pageA11y("/admin/promotions/new", async () => {
    page("/admin/promotions/new", "New discount code");
    await screen.findByLabelText(/^Internal name/u);
  });
  pageA11y("/admin/promotions/new with errors", async () => {
    const user = userEvent.setup();
    page("/admin/promotions/new", "New discount code");
    await user.click(await screen.findByRole("button", { name: "Create discount code" }));
    await screen.findByText(/^Check \d+ fields$/u);
  });
});

describe("Detail, batch, exports, redemptions", () => {
  it("staff see the masked code only; admin reveal shows it with copy controls and Hide returns focus", async () => {
    const user = userEvent.setup();
    session.role = "staff";
    const view = page(`/admin/promotions/${single.publicId}`, "Discount code");
    expect(await screen.findByText("Only administrators can show the full code.")).toBeTruthy();
    view.unmount();
    session.role = "admin";
    handlers[`${P}.reveal`] = () => ({ code: "SPRING-24" });
    page(`/admin/promotions/${single.publicId}`, "Discount code");
    (await screen.findByRole("button", { name: "Show code and link" })).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(callsTo("reveal")).toEqual([{ publicId: single.publicId }]));
    expect(await screen.findByRole("button", { name: "Copy link for Spring campaign" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.tagName).toBe("BUTTON"));
    expect(document.activeElement?.textContent).not.toContain("SPRING-24");
    await user.click(screen.getByRole("button", { name: "Hide code" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show code and link" })));
  });

  it("generate more codes: bounds checked, a retry after failure re-sends the same idempotency key", async () => {
    const user = userEvent.setup();
    let fail = true;
    handlers[`${P}.generateBatch`] = () => { if (fail) { fail = false; throw trpcError("UNAVAILABLE", "UNAVAILABLE", "Try again."); } return { promotion: batch, generated: 100 }; };
    page(`/admin/promotions/${batch.publicId}`, "Discount code");
    await user.click(await screen.findByRole("button", { name: "Generate more codes" }));
    const dialog = await screen.findByRole("dialog");
    const count = within(dialog).getByLabelText(/^Number of codes/u);
    await user.type(count, "6000");
    await user.click(within(dialog).getByRole("button", { name: "Generate" }));
    expect(await within(dialog).findByText("Enter a number from 1 to 5,000.")).toBeTruthy();
    await user.clear(count);
    await user.type(count, "100");
    await user.click(within(dialog).getByRole("button", { name: "Generate" }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(callsTo("generateBatch")).toHaveLength(2));
    const [a, b] = callsTo("generateBatch") as Array<{ idempotencyKey: string; count: number; prefix: string }>;
    expect(a).toMatchObject({ publicId: batch.publicId, count: 100, prefix: "PARTNER" });
    expect(a!.idempotencyKey).toBe(b!.idempotencyKey);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("CSV export goes through the server (formula-safe there) and downloads the returned file", async () => {
    const user = userEvent.setup();
    const created = vi.fn(() => "blob:synthetic");
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    handlers[`${P}.exportCodes`] = () => ({ fileName: "discount-codes-partner.csv", csv: "code\r\nPARTNER-X", rowCount: 250 });
    page(`/admin/promotions/${batch.publicId}`, "Discount code");
    await user.click(await screen.findByRole("button", { name: "Export codes (CSV)" }));
    await waitFor(() => expect(callsTo("exportCodes")).toEqual([{ publicId: batch.publicId }]));
    expect(click).toHaveBeenCalled();
    expect(await screen.findByText("250 rows downloaded.")).toBeTruthy();
  });

  it("release needs a reason; a refusal from the server is shown and the dialog stays open", async () => {
    const user = userEvent.setup();
    let refuse = true;
    handlers[`${P}.releaseRedemption`] = () => {
      if (refuse) { refuse = false; throw trpcError("CONFLICT", "REDEMPTION_RELEASE_NOT_ELIGIBLE", "This redemption can only be released when the order is cancelled, unpaid, and has no open invoice or pending payment."); }
      return { ...redemption, status: "released" };
    };
    page("/admin/promotions/redemptions", "Discount code redemptions");
    await user.click((await screen.findAllByRole("button", { name: "Release the redemption on RP-1001" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    let released = false;
    const base = handlers[`${P}.releaseRedemption`]!;
    handlers[`${P}.releaseRedemption`] = (i) => { const out = base(i); released = true; return out; };
    handlers[`${P}.redemptions`] = () => ({ items: [released ? { ...redemption, status: "released" } : redemption], nextCursor: null });
    await user.click(within(dialog).getByRole("button", { name: "Release" }));
    expect(await within(dialog).findByText("Explain why, in at least 5 characters.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText(/^Reason/u)));
    await user.type(within(dialog).getByLabelText(/^Reason/u), "Invoice voided by hand");
    await user.click(within(dialog).getByRole("button", { name: "Release" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/only be released when the order is cancelled/u);
    await user.click(within(dialog).getByRole("button", { name: "Release" }));
    await waitFor(() => expect(callsTo("releaseRedemption")).toHaveLength(2));
    expect(callsTo("releaseRedemption")[1]).toEqual({ redemptionPublicId: redemption.publicId, reason: "Invoice voided by hand" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Redemptions" })));
  });

  it("staff see redemptions but no release or export", async () => {
    session.role = "staff";
    page("/admin/promotions/redemptions", "Discount code redemptions");
    expect((await screen.findAllByText("RP-1001")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Release/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Export redemptions/u })).toBeNull();
  });

  pageA11y("/admin/promotions/:id single", async () => {
    page(`/admin/promotions/${single.publicId}`, "Discount code");
    await screen.findByRole("button", { name: "Show code and link" });
  });
  pageA11y("/admin/promotions/:id batch with generate dialog", async () => {
    const user = userEvent.setup();
    page(`/admin/promotions/${batch.publicId}`, "Discount code");
    await user.click(await screen.findByRole("button", { name: "Generate more codes" }));
    await screen.findByRole("dialog");
  });
  pageA11y("/admin/promotions/redemptions", async () => {
    page("/admin/promotions/redemptions", "Discount code redemptions");
    await screen.findAllByText("RP-1001");
  });
  pageA11y("/admin/promotions/redemptions release dialog", async () => {
    const user = userEvent.setup();
    page("/admin/promotions/redemptions", "Discount code redemptions");
    await user.click((await screen.findAllByRole("button", { name: "Release the redemption on RP-1001" }))[0]!);
    await screen.findByRole("dialog");
  });
});
