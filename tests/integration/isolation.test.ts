/**
 * Isolation (c): two fully enrolled customers on the assembled system. Customer B presents every resource
 * identifier customer A owns (order, file, grant, message, ticket, notification, invoice, session) to every
 * customer-reachable by-id procedure and route, and must get NOT_FOUND (no existence oracle) — never data.
 * A sweep over the live appRouter fails when a new customer-reachable procedure takes a resource id that
 * this file does not yet probe. See tests/integration/README.md.
 */
import type { AnyTRPCProcedure } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exampleWav } from "../../server/modules/files/fixtures.test-support.js";
import { appRouter } from "../../server/trpc/root.js";
import { adminProcedure, protectedProcedure, staffProcedure } from "../../server/trpc/trpc.js";
import {
  Browser, bootstrapAdmin, createSystem, registerCustomer, seedProduct, stepUp, STRONG_PASSWORD,
  type ReadyAdmin, type ReadyCustomer, type System, type TrpcResult,
} from "./harness.js";

let sys: System;
let admin: ReadyAdmin;
let a: ReadyCustomer;
let b: ReadyCustomer;
let bOrderId = "";

/** Everything customer A owns, by public id. */
const owned = {
  orderId: "", fileId: "", grantId: "", messageId: "", ticketId: "", notificationId: "", invoiceId: "",
  sessionId: "", projectName: "Isolation project alpha-7731",
};

type Def = { middlewares: unknown[]; type: "query" | "mutation" | "subscription"; inputs: unknown[] };
const defOf = (procedure: { _def: unknown }) => procedure._def as unknown as Def;

/** Top-level keys of a procedure's (possibly optional/wrapped) Zod object input. */
function inputKeys(procedure: AnyTRPCProcedure): string[] {
  const keys: string[] = [];
  for (const schema of defOf(procedure).inputs) {
    let current = schema as { shape?: Record<string, unknown>; unwrap?: () => unknown } | undefined;
    for (let depth = 0; depth < 4 && current && !current.shape && typeof current.unwrap === "function"; depth += 1) {
      current = current.unwrap() as typeof current;
    }
    if (current?.shape) keys.push(...Object.keys(current.shape));
  }
  return keys;
}

/** Customer-reachable = not under `.admin.` and not behind a staff/admin guard. */
function customerProcedures(): [string, AnyTRPCProcedure][] {
  const procedures = appRouter._def.procedures as unknown as Record<string, AnyTRPCProcedure>;
  const base = new Set(defOf(protectedProcedure as never).middlewares);
  const guards = [...defOf(staffProcedure as never).middlewares, ...defOf(adminProcedure as never).middlewares].filter((m) => !base.has(m));
  return Object.entries(procedures).filter(([path, procedure]) =>
    !path.includes(".admin.") && !guards.some((guard) => defOf(procedure).middlewares.includes(guard)));
}

const RESOURCE_KEY = /(Id|PublicId|Ids)$/;
/** Id-shaped keys that do not name another customer's resource (own-scoped or optional cursors). */
const NOT_A_FOREIGN_RESOURCE = new Set(["recoverySetId", "challengeId", "upToMessageId", "productPublicId"]);

/** Every probe customer B runs, keyed by procedure path. Inputs are otherwise valid so only ownership decides. */
function probes(): Record<string, { kind: "query" | "mutation"; input: () => unknown }> {
  const o = owned;
  const key = (tag: string) => `isolation-${tag}-0000000000`;
  return {
    "orders.get": { kind: "query", input: () => ({ orderId: o.orderId }) },
    "orders.summary": { kind: "query", input: () => ({ orderId: o.orderId }) },
    "orders.update": { kind: "mutation", input: () => ({ orderId: o.orderId, expectedVersion: 1, projectName: "Hijacked" }) },
    "orders.addNote": { kind: "mutation", input: () => ({ orderId: o.orderId, body: "Not my order." }) },
    "orders.transition": { kind: "mutation", input: () => ({ orderId: o.orderId, expectedVersion: 1, toStatus: "cancelled" }) },
    "orders.sharing.list": { kind: "query", input: () => ({ orderId: o.orderId }) },
    "orders.sharing.invite": { kind: "mutation", input: () => ({ orderId: o.orderId, email: "intruder@example.test", role: "viewer" }) },
    "orders.sharing.revoke": { kind: "mutation", input: () => ({ orderId: o.orderId, grantId: o.grantId }) },
    "orders.sharing.respond": { kind: "mutation", input: () => ({ grantId: o.grantId, accept: true }) },
    "files.list": { kind: "query", input: () => ({ orderId: o.orderId }) },
    "files.issueDownloadTicket": { kind: "mutation", input: () => ({ fileId: o.fileId }) },
    "engagement.messages.listByOrder": { kind: "query", input: () => ({ orderId: o.orderId }) },
    "engagement.messages.unreadSummary": { kind: "query", input: () => ({ orderId: o.orderId }) },
    "engagement.messages.send": { kind: "mutation", input: () => ({ orderId: o.orderId, body: "Intrusion.", idempotencyKey: key("msg") }) },
    "engagement.messages.markOrderRead": { kind: "mutation", input: () => ({ orderId: o.orderId }) },
    "engagement.tickets.get": { kind: "query", input: () => ({ ticketId: o.ticketId }) },
    "engagement.tickets.create": {
      kind: "mutation",
      input: () => ({ subject: "About an order", category: "order", body: "Linking someone else's order.", relatedOrderId: o.orderId, idempotencyKey: key("tkt") }),
    },
    "engagement.tickets.reply": { kind: "mutation", input: () => ({ ticketId: o.ticketId, body: "Intrusion.", idempotencyKey: key("rep") }) },
    "engagement.tickets.close": { kind: "mutation", input: () => ({ ticketId: o.ticketId }) },
    "engagement.tickets.reopen": { kind: "mutation", input: () => ({ ticketId: o.ticketId, reason: "Intrusion." }) },
    "engagement.notifications.markRead": { kind: "mutation", input: () => ({ notificationId: o.notificationId }) },
    "compliance.intake.listForOrder": { kind: "query", input: () => ({ orderPublicId: o.orderId }) },
    "compliance.intake.getSubmission": { kind: "query", input: () => ({ orderPublicId: o.orderId, questionnairePublicId: o.orderId }) },
    "compliance.intake.saveDraft": { kind: "mutation", input: () => ({ orderPublicId: o.orderId, questionnairePublicId: o.orderId, answers: {} }) },
    "compliance.intake.submit": { kind: "mutation", input: () => ({ orderPublicId: o.orderId, questionnairePublicId: o.orderId, answers: {} }) },
    "compliance.invoices.listForOrder": { kind: "query", input: () => ({ orderPublicId: o.orderId }) },
    "compliance.invoices.get": { kind: "query", input: () => ({ invoicePublicId: o.invoiceId }) },
    "identity.sessions.revoke": { kind: "mutation", input: () => ({ sessionId: o.sessionId }) },
    // Unknown-id probes (README: a cross-account passkey / published-policy fixture is it.todo).
    "assurance.renamePasskey": { kind: "mutation", input: () => ({ publicId: o.orderId, name: "Intruder key" }) },
    "assurance.removePasskey": { kind: "mutation", input: () => ({ publicId: o.orderId }) },
    "compliance.policies.accept": {
      kind: "mutation", input: () => ({ versionPublicId: o.invoiceId, contentHash: "0".repeat(64), orderPublicId: o.orderId }),
    },
  };
}

const call = (browser: Browser, kind: "query" | "mutation", path: string, input: unknown): Promise<TrpcResult> =>
  kind === "query" ? browser.query(path, input) : browser.mutate(path, input);

beforeAll(async () => {
  sys = await createSystem();
  admin = await bootstrapAdmin(sys);
  const productId = await seedProduct(admin);
  a = await registerCustomer(sys, "alice.isolation@example.test", "Alice Isolation");
  b = await registerCustomer(sys, "bob.isolation@example.test", "Bob Isolation");

  const order = Browser.ok(await a.browser.mutate<{ publicId: string }>("orders.create", {
    projectName: owned.projectName, items: [{ productPublicId: productId, quantity: 1 }], idempotencyKey: "isolation-order-a-0001",
  }));
  owned.orderId = order.publicId;
  Browser.ok(await a.browser.mutate("orders.addNote", { orderId: owned.orderId, body: "Private note of A." }));
  bOrderId = Browser.ok(await b.browser.mutate<{ publicId: string }>("orders.create", {
    projectName: "Isolation project bravo", items: [{ productPublicId: productId, quantity: 1 }], idempotencyKey: "isolation-order-b-0001",
  })).publicId;

  const upload = await a.browser.raw("post", `/api/files/upload/${owned.orderId}`).attach("files", exampleWav(), "private.wav");
  expect(upload.status).toBe(200);
  owned.fileId = upload.body.results[0].file.publicId as string;

  Browser.ok(await a.browser.mutate("orders.sharing.invite", { orderId: owned.orderId, email: "carol.collab@example.test", role: "viewer" }));
  const grants = Browser.ok(await a.browser.query<unknown>("orders.sharing.list", { orderId: owned.orderId }));
  owned.grantId = JSON.stringify(grants).match(/"(?:grantId|publicId)":"([0-9A-HJKMNP-TV-Z]{26})"/)?.[1] ?? "";

  owned.messageId = Browser.ok(await a.browser.mutate<{ publicId: string }>("engagement.messages.send", {
    orderId: owned.orderId, body: "Private message of A.", idempotencyKey: "isolation-msg-a-0001",
  })).publicId;
  owned.ticketId = Browser.ok(await a.browser.mutate<{ ticket: { publicId: string } }>("engagement.tickets.create", {
    subject: "Private ticket of A", category: "general", body: "Only A and staff may read this.", idempotencyKey: "isolation-tkt-a-0001",
  })).ticket.publicId;

  // A notification for A, emitted the way every module does (service-internal notify, in its own tx).
  const aUser = await sys.container.services.identity.findUserIdByEmail(a.email);
  await sys.t.db.transaction((tx) => sys.container.services.engagement.notify({
    userId: aUser!.userId, kind: "order.status_changed", title: "Your order was updated", body: "Synthetic isolation notice.", link: `/orders/${owned.orderId}`,
  }, tx));
  const notes = Browser.ok(await a.browser.query<{ items: { publicId: string }[] }>("engagement.notifications.list", {}));
  owned.notificationId = notes.items[0]?.publicId ?? "";

  Browser.ok(await stepUp(sys, admin.browser, admin.password, admin.secret));
  owned.invoiceId = Browser.ok(await admin.browser.mutate<{ invoicePublicId: string }>("compliance.invoices.admin.createDraft", {
    orderPublicId: owned.orderId, currency: "USD", lines: [{ description: "Synthetic line", quantity: 1, unitAmountMinor: 1500 }],
  })).invoicePublicId;
  Browser.ok(await admin.browser.mutate("compliance.invoices.admin.issue", { invoicePublicId: owned.invoiceId }));

  const sessions = Browser.ok(await a.browser.query<{ items: { sessionId: string; current: boolean }[] }>("identity.sessions.list"));
  owned.sessionId = sessions.items.find((s) => s.current)?.sessionId ?? "";

  for (const [name, value] of Object.entries(owned)) expect(value, name).not.toBe("");
}, 120_000);

afterAll(async () => sys?.close());

describe("cross-customer isolation (assembled system)", () => {
  it("customer A can read every one of its own resources (the probes below are meaningful)", async () => {
    Browser.ok(await a.browser.query("orders.get", { orderId: owned.orderId }));
    Browser.ok(await a.browser.query("engagement.tickets.get", { ticketId: owned.ticketId }));
    Browser.ok(await a.browser.query("compliance.invoices.get", { invoicePublicId: owned.invoiceId }));
    Browser.ok(await a.browser.mutate("files.issueDownloadTicket", { fileId: owned.fileId }));
  });

  it("customer B gets NOT_FOUND from every by-id procedure for A's resources", async () => {
    // B is fully stepped-up, so a freshness gate can never mask a missing ownership check.
    Browser.ok(await stepUp(sys, b.browser, STRONG_PASSWORD, b.secret));
    const failures: string[] = [];
    for (const [path, probe] of Object.entries(probes())) {
      const result = await call(b.browser, probe.kind, path, probe.input());
      const code = result.error?.safe.domainCode;
      if (result.status === 200 || code !== "NOT_FOUND") failures.push(`${path}: ${result.status} ${code ?? ""} ${result.error?.safe.reasonCode ?? ""}`);
    }
    expect(failures).toEqual([]);
  });

  it("B's own-scoped lists and search never surface A's resources", async () => {
    const leaks: string[] = [];
    const ids = [owned.orderId, owned.fileId, owned.messageId, owned.ticketId, owned.notificationId, owned.invoiceId];
    const views: [string, unknown][] = [
      ["orders.list", {}], ["engagement.messages.threads", {}], ["engagement.tickets.list", {}],
      ["engagement.notifications.list", {}], ["compliance.invoices.listMine", {}], ["orders.sharing.myInvitations", undefined],
      ["files.list", { orderId: bOrderId }], ["engagement.search.query", { query: "alpha-7731" }],
    ];
    for (const [path, input] of views) {
      const body = JSON.stringify(Browser.ok(await b.browser.query(path, input)));
      for (const id of ids) if (body.includes(id)) leaks.push(`${path} leaks ${id}`);
      if (body.includes(owned.projectName)) leaks.push(`${path} leaks A's project name`);
    }
    expect(leaks).toEqual([]);
  });

  it("B cannot attach A's file to B's own message", async () => {
    const result = await b.browser.mutate("engagement.messages.send", {
      orderId: bOrderId, body: "Look at this.", attachmentFileIds: [owned.fileId], idempotencyKey: "isolation-attach-b-0001",
    });
    expect(result.error?.safe.domainCode).toBe("NOT_FOUND");
  });

  it("HTTP routes: B cannot upload into A's order or redeem A's download ticket", async () => {
    const upload = await b.browser.raw("post", `/api/files/upload/${owned.orderId}`).attach("files", exampleWav(), "intrusion.wav");
    expect(upload.status).toBe(404);
    const { ticket } = Browser.ok(await a.browser.mutate<{ ticket: string }>("files.issueDownloadTicket", { fileId: owned.fileId }));
    const stolen = await b.browser.raw("post", "/api/files/download").send({ ticket });
    expect(stolen.status).toBe(404);
  });

  it("A's resources are unchanged after B's attempts", async () => {
    const detail = JSON.stringify(Browser.ok(await a.browser.query("orders.get", { orderId: owned.orderId })));
    expect(detail).toContain(owned.projectName);
    expect(detail).not.toContain("Hijacked");
    expect(detail).not.toContain("Not my order.");
    const sessions = Browser.ok(await a.browser.query<{ items: { sessionId: string }[] }>("identity.sessions.list"));
    expect(sessions.items.map((s) => s.sessionId)).toContain(owned.sessionId);
    const messages = JSON.stringify(Browser.ok(await a.browser.query("engagement.messages.listByOrder", { orderId: owned.orderId })));
    expect(messages).not.toContain("Intrusion.");
  });

  it.todo("B cannot remove or rename A's passkey (needs a virtual WebAuthn authenticator fixture for A)");
  it.todo("B cannot accept a published policy against A's order (needs an admin-published policy version fixture)");

  it("every customer-reachable procedure that takes a resource id is probed here", () => {
    const covered = probes();
    const missing = customerProcedures()
      .filter(([path, procedure]) => inputKeys(procedure).some((k) => RESOURCE_KEY.test(k) && !NOT_A_FOREIGN_RESOURCE.has(k)) && !covered[path])
      .map(([path, procedure]) => `${path} (${inputKeys(procedure).join(", ")})`);
    expect(missing).toEqual([]);
  });
});
