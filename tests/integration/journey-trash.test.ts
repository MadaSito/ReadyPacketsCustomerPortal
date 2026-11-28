/** Increment 09: lifecycle, capability, and visibility checks against the assembled system. */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ULID_PATTERN, ulid } from "../../server/core/ids.js";
import { users } from "../../server/modules/identity/schema.js";
import { jobRuns } from "../../server/modules/jobs/schema.js";
import { orders } from "../../server/modules/orders/schema.js";
import { isPlatformSettingsStore } from "../../server/modules/platform/settingsStore.js";
import { TRASH_JOB_RETENTION_CLEANUP } from "../../server/modules/trash/jobNames.js";
import type { TrashSettingsPreview } from "../../server/modules/trash/types.js";
import { appRouter } from "../../server/trpc/root.js";
import {
  Browser, bootstrapAdmin, createSystem, enrolTotp, linkToken, registerCustomer, seedProduct, stepUp, STRONG_PASSWORD,
  type ReadyAdmin, type ReadyCustomer, type System, type TrpcResult,
} from "./harness.js";

let sys: System;
let admin: ReadyAdmin;
let owner: ReadyCustomer;
let staff: Browser;
let productPublicId: string;
let apiToken: string;
const staffEmail = "trash.staff@example.test";
const lifecycleEmail = "trash.lifecycle@example.test";

type Target = { kind: "order" | "customer"; publicId: string };
type MovedTarget = Target & { batchId: string };
type Action = "restore" | "purge";
type MoveResult = { batchId: string; cascadedOrders: number };
type ItemResults = { results: { kind: Target["kind"]; publicId: string; ok: boolean }[] };
const listInput = (kind: Target["kind"]) => ({ kind, sort: "movedAt", dir: "desc", limit: 10 });
const moveInput = (target: Target, label: string) => ({ ...target, idempotencyKey: `integration-trash-move-${label}` });
const actionInput = (target: MovedTarget, action: Action, label: string, confirmation?: string) => ({
  items: [target], idempotencyKey: `integration-trash-${action}-${label}`, ...(action === "purge" ? { confirmation } : {}),
});
const move = (target: Target, label: string) => admin.browser.mutate<MoveResult>("trash.moveToTrash", moveInput(target, label));
const act = (target: MovedTarget, action: Action, label: string, confirmation?: string) =>
  admin.browser.mutate<ItemResults>(`trash.${action}`, actionInput(target, action, label, confirmation));

function moved(target: Target, result: TrpcResult<MoveResult>, expectedCascadedOrders = 0): MovedTarget {
  const { batchId, cascadedOrders } = Browser.ok(result);
  expect(batchId).toMatch(ULID_PATTERN);
  expect(cascadedOrders).toBe(expectedCascadedOrders);
  return { ...target, batchId };
}

function expectItemSuccess(result: TrpcResult<ItemResults>, target: Target) {
  expect(Browser.ok(result).results).toEqual([expect.objectContaining({ kind: target.kind, publicId: target.publicId, ok: true })]);
}

async function customerRow(browser: Browser) {
  const { user } = Browser.ok(await browser.query<{ user: { publicId: string } }>("identity.me"));
  const [row] = await sys.t.db.select().from(users).where(eq(users.publicId, user.publicId));
  if (!row?.customerRef) throw new Error("Synthetic customer reference not assigned");
  return { ...row, customerRef: row.customerRef };
}

async function makeOrder(browser: Browser, label: string) {
  return Browser.ok(await browser.mutate<{ publicId: string; reference: string }>("orders.create", {
    projectName: `Synthetic trash ${label}`, items: [{ productPublicId, quantity: 1 }],
    idempotencyKey: `integration-trash-order-${label}`,
  }));
}

async function invoice(orderPublicId: string) {
  const { invoicePublicId } = Browser.ok(await admin.browser.mutate<{ invoicePublicId: string }>("compliance.invoices.admin.createDraft", {
    orderPublicId, currency: "USD", lines: [{ description: "Synthetic unit", quantity: 1, unitAmountMinor: 1500 }],
  }));
  Browser.ok(await admin.browser.mutate("compliance.invoices.admin.issue", { invoicePublicId }));
  return invoicePublicId;
}

async function freshStepUp() {
  Browser.ok(await stepUp(sys, admin.browser, admin.password, admin.secret));
}

async function paidRecords(browser: Browser, orderPublicId: string, label: string) {
  await freshStepUp();
  const invoicePublicId = await invoice(orderPublicId);
  Browser.ok(await admin.browser.mutate("compliance.invoices.admin.recordManualPayment", {
    invoicePublicId, method: "check", amountMinor: 1500, currency: "USD",
    reference: "Synthetic cash equivalent", idempotencyKey: `integration-trash-payment-${label}`,
  }));
  const receipts = Browser.ok(await browser.query<{ receiptPublicId: string }[]>("compliance.receipts.forOrder", { orderPublicId }));
  expect(receipts).toHaveLength(1);
  return { invoicePublicId, receiptPublicId: receipts[0]!.receiptPublicId };
}

function safeResponse(result: TrpcResult) {
  const { status, error, data } = result;
  return {
    status, data, code: error?.code, domain: error?.safe.domainCode, reason: error?.safe.reasonCode,
    safeMessage: result.res.body?.error?.json?.data?.safe?.safeMessage as unknown,
    details: result.res.body?.error?.json?.data?.safe?.details as unknown,
    message: result.res.body?.error?.json?.message as unknown,
  };
}

const publicGet = (path: string) => sys.http.get(`/api/v1${path}`)
  .set("Host", new URL(sys.config.canonicalOrigin).host)
  .set("Authorization", `Bearer ${apiToken}`);

beforeAll(async () => {
  sys = await createSystem();
  admin = await bootstrapAdmin(sys);
  await freshStepUp();
  const { settings } = sys.container.services;
  if (!isPlatformSettingsStore(settings)) throw new Error("Expected assembled platform settings");
  await settings.setFeature("cart", true);
  productPublicId = await seedProduct(admin);
  const { version } = Browser.ok(await admin.browser.query<{ version: number }>("publicApi.admin.settings.get"));
  Browser.ok(await admin.browser.mutate("publicApi.admin.settings.update", { expectedVersion: version, enabled: true, retentionDays: 7 }));
  ({ token: apiToken } = Browser.ok(await admin.browser.mutate<{ token: string }>("publicApi.admin.keys.create", {
    name: "Synthetic trash isolation", scopes: ["orders:read", "files:read"], expiresAt: null,
    ipAllowList: [], rateLimitPerMinute: 100, requireSigning: false,
  })));
  Browser.ok(await admin.browser.mutate("identity.admin.staff.create", { email: staffEmail, name: "Sam Staff", role: "staff" }));
  const [mail] = await sys.inbox(staffEmail);
  if (!mail) throw new Error("Synthetic staff invitation missing");
  staff = sys.browser();
  Browser.ok(await staff.mutate("identity.activateAccount", { token: linkToken(mail.text), password: STRONG_PASSWORD }));
  Browser.ok(await staff.mutate("identity.signIn", { email: staffEmail, password: STRONG_PASSWORD }));
  await enrolTotp(sys, staff);
  owner = await registerCustomer(sys, "trash.owner@example.test", "Zeus Greene");
}, 120_000);

afterAll(async () => sys?.close());

describe("trash lifecycle across modules", () => {
  it("denies all four trash operations to full customer and staff sessions", async () => {
    const order = await makeOrder(owner.browser, "permissions");
    const target: Target = { kind: "order", publicId: order.publicId };
    const customer = await customerRow(owner.browser);
    Browser.ok(await admin.browser.query("trash.list", listInput("order")));
    for (const [role, browser] of [["customer", owner.browser], ["staff", staff]] as const) {
      expect(Browser.ok(await browser.query("identity.me"))).toMatchObject({ state: "full", user: { role } });
      for (const [entity, confirmation] of [[target, order.reference], [{ kind: "customer", publicId: customer.publicId }, customer.customerRef]] as const) {
        const withBatch = { ...entity, batchId: ulid() };
        const denied = [
          ["list", await browser.query("trash.list", listInput(entity.kind))],
          ["moveToTrash", await browser.mutate("trash.moveToTrash", moveInput(entity, role))],
          ["restore", await browser.mutate("trash.restore", actionInput(withBatch, "restore", role))],
          ["purge", await browser.mutate("trash.purge", actionInput(withBatch, "purge", role, confirmation))],
        ] as const;
        for (const [action, result] of denied) {
          expect(result, `${role}/${entity.kind}/${action}`).toMatchObject({ status: 403, error: { code: "FORBIDDEN" } });
        }
      }
    }
    Browser.ok(await owner.browser.query("orders.get", { orderId: target.publicId }));
  });

  it("makes hidden and tombstoned orders indistinguishable from never-created orders across module families", async () => {
    const order = await makeOrder(owner.browser, "visibility");
    const target: Target = { kind: "order", publicId: order.publicId };
    const unpaid = await invoice(order.publicId);
    const cart = Browser.ok(await owner.browser.mutate<{ version: number }>("cart.addItems", { items: [{ productPublicId, quantity: 1 }] }));
    const missingOrder = ulid();
    const missingInvoice = ulid();
    const probes = (orderId: string, invoicePublicId: string) => [
      ["orders.get", "query", { orderId }],
      ["orders.summary", "query", { orderId }],
      ["orders.stages.workspace", "query", { orderId }],
      ["files.list", "query", { orderId }],
      ["engagement.messages.listByOrder", "query", { orderId }],
      ["engagement.messages.unreadSummary", "query", { orderId }],
      ["engagement.messages.send", "mutation", { orderId, body: "Synthetic visibility probe", idempotencyKey: "trash-visibility-message" }],
      ["compliance.invoices.listForOrder", "query", { orderPublicId: orderId }],
      ["compliance.invoices.get", "query", { invoicePublicId }],
      ["payments.startInvoiceCheckout", "mutation", { invoicePublicId, idempotencyKey: "trash-visibility-payment" }],
      ["cart.setTarget", "mutation", { expectedVersion: cart.version, addToOrderPublicId: orderId }],
      ["cart.addItems", "mutation", { items: [{ productPublicId, quantity: 1 }], addToOrderPublicId: orderId }],
    ] as const;
    const observeTrpc = async (orderId: string, invoicePublicId: string) => {
      const results: Record<string, ReturnType<typeof safeResponse>> = {};
      for (const [path, method, input] of probes(orderId, invoicePublicId)) {
        expect(path in appRouter._def.procedures, `${path} must exist before accepting its 404`).toBe(true);
        const result = method === "query" ? await owner.browser.query(path, input) : await owner.browser.mutate(path, input);
        expect(result.status, path).toBe(404);
        expect(result.error?.code, path).toBe("NOT_FOUND");
        results[path] = safeResponse(result);
      }
      return results;
    };
    const observePublicApi = async (orderId: string) => {
      const problems = [];
      for (const tail of ["", "/files"]) {
        const api = await publicGet(`/orders/${orderId}${tail}`);
        expect(api.status, `GET /api/v1/orders/:id${tail}`).toBe(404);
        expect(api.headers["content-type"]).toMatch(/^application\/problem\+json\b/);
        const { request_id: _requestId, ...problem } = api.body as Record<string, unknown>;
        expect(problem).toMatchObject({ title: "Not found", status: 404 });
        problems.push(problem);
      }
      return problems;
    };
    Browser.ok(await owner.browser.query("orders.get", { orderId: order.publicId }));
    Browser.ok(await owner.browser.query("compliance.invoices.get", { invoicePublicId: unpaid }));
    const trpcBaseline = await observeTrpc(missingOrder, missingInvoice);
    expect((await publicGet(`/orders/${order.publicId}`)).status, "live order through Public API").toBe(200);
    expect((await publicGet(`/orders/${order.publicId}/files`)).status, "live order files through Public API").toBe(200);
    const publicBaseline = await observePublicApi(missingOrder);
    const trashed = moved(target, await move(target, "visibility"));
    expect.soft(await observeTrpc(order.publicId, unpaid), "trashed tRPC response").toEqual(trpcBaseline);
    expect.soft(await observePublicApi(order.publicId), "trashed Public API response").toEqual(publicBaseline);
    await freshStepUp();
    expectItemSuccess(await act(trashed, "purge", "visibility", order.reference), target);
    expect(await observeTrpc(order.publicId, unpaid), "tombstoned tRPC response").toEqual(trpcBaseline);
    expect(await observePublicApi(order.publicId), "tombstoned Public API response").toEqual(publicBaseline);
  }, 60_000);

  it("restores a suspended customer and its orders together, then frees the address without inheriting records", async () => {
    const customer = await registerCustomer(sys, lifecycleEmail, "Casey Lifecycle");
    const original = await customerRow(customer.browser);
    const originalCookies = [...customer.browser.jar.entries()];
    const target: Target = { kind: "customer", publicId: original.publicId };
    const order = await makeOrder(customer.browser, "cascade");
    const kept = await paidRecords(customer.browser, order.publicId, "cascade");
    const before = Browser.ok(await admin.browser.query<{ statusKey: string }>("orders.admin.get", { orderId: order.publicId }));
    Browser.ok(await customer.browser.mutate("billingProfile.save", {
      expectedVersion: 0, details: { fullName: "Casey Lifecycle", email: lifecycleEmail, country: "US", addressLine1: "100 Synthetic Way", city: "Austin", postalCode: "78701", region: "TX" },
    }));
    const active = await move(target, "active-must-fail");
    expect(active).toMatchObject({ status: 409, error: { safe: { reasonCode: "CUSTOMER_NOT_SUSPENDED" } } });
    const setStatus = (status: "active" | "suspended") => admin.browser.mutate("identity.admin.customers.setStatus", {
      customerId: original.publicId, status, reasonCode: "SYNTHETIC_TRASH_TEST",
    });
    Browser.ok(await setStatus("suspended"));
    const first = moved(target, await move(target, "customer-first"), 1);
    expect((await admin.browser.query("identity.admin.customers.get", { customerId: original.publicId })).status).toBe(404);
    expect((await admin.browser.query("orders.admin.get", { orderId: order.publicId })).status).toBe(404);
    expect(await customer.browser.query("identity.me")).toMatchObject({ status: 401, error: { code: "UNAUTHORIZED" } });
    expect((await setStatus("active")).status).toBe(404);
    const retry = sys.browser();
    expect(Browser.ok(await retry.mutate("identity.register", { email: lifecycleEmail, name: "Not a replacement", password: STRONG_PASSWORD }))).toEqual({ accepted: true });
    expect(await sys.inbox(lifecycleEmail)).toEqual([]);

    expectItemSuccess(await act(first, "restore", "customer-first"), target);
    expect(Browser.ok(await admin.browser.query("identity.admin.customers.get", { customerId: original.publicId }))).toMatchObject({ customer: { status: "suspended" } });
    expect(Browser.ok(await admin.browser.query("orders.admin.get", { orderId: order.publicId }))).toMatchObject({ statusKey: before.statusKey });
    const second = moved(target, await move(target, "customer-second"), 1);
    expect(second.batchId).not.toBe(first.batchId);
    await freshStepUp();
    expectItemSuccess(await act(second, "purge", "customer-second", original.customerRef), target);
    const replacement = await registerCustomer(sys, lifecycleEmail, "Riley Replacement");
    const created = await customerRow(replacement.browser);
    expect(created.publicId).not.toBe(original.publicId);
    expect(created.customerRef).not.toBe(original.customerRef);
    expect(created.emailIndex).toBe(original.emailIndex);
    expect(Browser.ok(await replacement.browser.query("orders.list", {}))).toMatchObject({ items: [] });
    expect(Browser.ok(await replacement.browser.query("billingProfile.get"))).toBeNull();
    expect((await replacement.browser.query("orders.get", { orderId: order.publicId })).status).toBe(404);
    expect((await replacement.browser.query("compliance.invoices.get", { invoicePublicId: kept.invoicePublicId })).status).toBe(404);
    expect((await replacement.browser.query("compliance.receipts.get", { receiptPublicId: kept.receiptPublicId })).status).toBe(404);
    const stale = sys.browser();
    for (const [name, cookie] of originalCookies) stale.jar.set(name, cookie);
    expect(await stale.query("identity.me")).toMatchObject({ status: 401, error: { code: "UNAUTHORIZED" } });
    const [old] = await sys.t.db.select().from(users).where(eq(users.publicId, original.publicId));
    const [cascaded] = await sys.t.db.select().from(orders).where(eq(orders.publicId, order.publicId));
    expect(old!.emailIndex).not.toBe(original.emailIndex);
    expect(old).toMatchObject({ status: "deactivated", purgedAt: expect.any(Date) });
    expect(cascaded).toMatchObject({ purgedAt: expect.any(Date), reference: order.reference });
  }, 60_000);

  it("keeps paid invoices, receipts, and order audit evidence across trash, restore and permanent deletion", async () => {
    const order = await makeOrder(owner.browser, "retained-money");
    const target: Target = { kind: "order", publicId: order.publicId };
    const { invoicePublicId, receiptPublicId } = await paidRecords(owner.browser, order.publicId, "retained-money");
    const kept = async () => ({
      invoice: Browser.ok(await owner.browser.query<Record<string, unknown>>("compliance.invoices.get", { invoicePublicId })),
      receipt: Browser.ok(await owner.browser.query<Record<string, unknown> & { snapshot: Record<string, unknown> }>(
        "compliance.receipts.get", { receiptPublicId },
      )),
    });
    const before = await kept();
    expect(before.invoice).toMatchObject({ status: "paid", orderLifecycleState: "live" });
    expect(before.receipt).toMatchObject({ orderLifecycleState: "live", amountPaidMinor: 1500 });
    const audited = async (result: TrpcResult, ...names: string[]) => {
      Browser.ok(result);
      const actual = await sys.audit({ requestId: result.requestId });
      expect(actual.map((event) => event.eventName)).toEqual(expect.arrayContaining(names));
      return actual.filter((event) => names.includes(event.eventName)).map((event) => event.id);
    };
    const firstMove = await move(target, "money-first");
    const firstTarget = moved(target, firstMove);
    const first = await audited(firstMove, "order.trashed");
    expect(await kept()).toEqual({
      invoice: { ...before.invoice, orderLifecycleState: "trashed", onlinePaymentConfigured: false, onlinePaymentMessage: "Order is not active" },
      receipt: { ...before.receipt, orderLifecycleState: "trashed" },
    });
    const restored = await act(firstTarget, "restore", "money-first");
    expectItemSuccess(restored, target);
    const restoration = await audited(restored, "order.restored");
    Browser.ok(await owner.browser.query("orders.get", { orderId: order.publicId }));
    expect(await kept()).toEqual(before);
    const secondMove = await move(target, "money-second");
    const secondTarget = moved(target, secondMove);
    expect(secondTarget.batchId).not.toBe(firstTarget.batchId);
    const second = await audited(secondMove, "order.trashed");
    await freshStepUp();
    const purged = await act(secondTarget, "purge", "money-second", order.reference);
    expectItemSuccess(purged, target);
    await audited(purged, "order.purge_started", "order.purged");
    const after = await kept();
    expect(after.invoice).toEqual({
      ...before.invoice, orderLifecycleState: "deleted", projectName: "Deleted order",
      onlinePaymentConfigured: false, onlinePaymentMessage: "Order is not active",
    });
    // The receipt redacts the mutable project label while preserving the frozen settlement and party data.
    expect(after.receipt).toEqual({
      ...before.receipt, orderLifecycleState: "deleted", projectName: "Deleted order",
      snapshot: { ...before.receipt.snapshot, projectName: "Deleted order" },
    });
    const [tombstone] = await sys.t.db.select().from(orders).where(eq(orders.publicId, order.publicId));
    expect(tombstone).toMatchObject({ reference: order.reference, projectName: "Deleted order", purgedAt: expect.any(Date) });
    const retained = await sys.audit({ eventName: ["order.trashed", "order.restored"] });
    expect(retained.map((event) => event.id)).toEqual(expect.arrayContaining([...first, ...restoration, ...second]));
  }, 60_000);

  it("runs the real retention worker and keeps a cascaded order until its customer's later deadline", async () => {
    const customer = await registerCustomer(sys, "trash.retention@example.test", "Taylor Retention");
    const account = await customerRow(customer.browser);
    const cascaded = await makeOrder(customer.browser, "retention-cascaded");
    const standalone = await makeOrder(owner.browser, "retention-standalone");
    const proposed = { autoPurgeEnabled: true, orderDays: 7, customerDays: 30 };
    await freshStepUp();
    const preview = Browser.ok(await admin.browser.query<TrashSettingsPreview>("trash.settings.preview", proposed));
    expect(preview).toMatchObject({ becomeDue: 0, requiresConfirmation: true, confirmationPhrase: "DELETE 0" });
    Browser.ok(await admin.browser.mutate("trash.settings.update", {
      ...proposed, expectedVersion: preview.version, reviewedDueCount: preview.becomeDue,
      confirmation: preview.confirmationPhrase, idempotencyKey: "integration-trash-shorter-order-retention",
    }));
    Browser.ok(await admin.browser.mutate("identity.admin.customers.setStatus", {
      customerId: account.publicId, status: "suspended", reasonCode: "SYNTHETIC_RETENTION_TEST",
    }));
    const order = { kind: "order", publicId: standalone.publicId } as const;
    const user = { kind: "customer", publicId: account.publicId } as const;
    moved(order, await move(order, "retention-standalone"));
    moved(user, await move(user, "retention-customer"), 1);
    const orderRow = async (publicId: string) =>
      (await sys.t.db.select().from(orders).where(eq(orders.publicId, publicId)))[0];
    const accountRow = async () =>
      (await sys.t.db.select().from(users).where(eq(users.publicId, account.publicId)))[0];
    const sweep = async () => {
      const { jobId } = await sys.container.services.jobs.enqueue(TRASH_JOB_RETENTION_CLEANUP, {});
      await sys.drainJobs();
      const [job] = await sys.t.db.select().from(jobRuns).where(eq(jobRuns.publicId, jobId));
      expect(job).toMatchObject({ state: "completed" });
      const completed = await sys.audit({ eventName: "trash.cleanup_completed" });
      expect(completed.find((event) => event.jobId === jobId)).toMatchObject({
        actorRole: "system", outcome: "completed", attributes: { due: 1, purged: 1, failed: 0 },
      });
    };
    const day = 86_400_000;
    sys.clock.advance(8 * day);
    await sweep();
    expect(await orderRow(standalone.publicId)).toMatchObject({ purgedAt: expect.any(Date) });
    expect(await orderRow(cascaded.publicId)).toMatchObject({ trashedAt: expect.any(Date), purgedAt: null });
    expect(await accountRow()).toMatchObject({ trashedAt: expect.any(Date), purgedAt: null });
    sys.clock.advance(23 * day);
    await sweep();
    expect(await orderRow(cascaded.publicId)).toMatchObject({ purgedAt: expect.any(Date) });
    expect(await accountRow()).toMatchObject({ purgedAt: expect.any(Date) });
  }, 60_000);
});
