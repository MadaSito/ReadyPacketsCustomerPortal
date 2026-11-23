/**
 * Isolation (c): two fully enrolled customers on the assembled system. Customer B presents every resource
 * identifier customer A owns (order, file, grant, message, ticket, notification, invoice, session) to every
 * customer-reachable by-id procedure and route, and must get NOT_FOUND (no existence oracle) — never data.
 * Shared resources have explicit visibility-filter or capability assertions where ownership does not apply.
 * A sweep over the live appRouter fails when a new customer-reachable procedure takes a resource id that
 * this file does not yet probe. See tests/integration/README.md.
 */
import type { AnyTRPCProcedure } from "@trpc/server";
import { eq } from "drizzle-orm";
import superjson from "superjson";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { carts } from "../../server/modules/cart/schema.js";
import type { CartView, CheckoutCartResult } from "../../server/modules/cart/types.js";
import { complianceInvoices } from "../../server/modules/compliance/schema.js";
import { DEFAULT_COMMUNITY_CONFIG } from "../../server/modules/community/settings.js";
import { exampleDocx, exampleWav } from "../../server/modules/files/fixtures.test-support.js";
import { integrationProductionDispatches } from "../../server/modules/integrations/schema.js";
import { knowledgeArticleAttachments, knowledgeArticles, knowledgeCategories } from "../../server/modules/knowledge/schema.js";
import { orderNameHistory, orders } from "../../server/modules/orders/schema.js";
import { paymentAttempts } from "../../server/modules/payments/schema.js";
import { isPlatformSettingsStore } from "../../server/modules/platform/settingsStore.js";
import { storageCopyAttempts } from "../../server/modules/storage/schema.js";
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
let aOrderVersion = 0;
const gateKey = "isolation_policy";

/** Everything customer A owns, by public id. */
const owned = {
  orderId: "", fileId: "", grantId: "", messageId: "", ticketId: "", notificationId: "", invoiceId: "",
  sessionId: "", projectName: "Isolation project alpha-7731",
  ackHash: "", categoryId: "", staffCategoryId: "", topicId: "", postId: "", sharedTopicId: "",
  cartId: "", cartItemId: "", checkedOutCartId: "", paymentInvoiceId: "", attemptId: "", staffArticleId: "", staffAttachmentId: "",
  policyVersionId: "", policyHash: "", receiptId: "", copyAttemptId: "", refundPaymentId: "", dispatchId: "",
  customerPublicId: "", productId: "", documentFileId: "", paymentReceiptId: "",
  enforcementDocumentId: "", enforcementVersionId: "", staffPolicyVersionId: "", staffPolicyHash: "", policyNoticeId: "",
};
let cartVersion = 0;
let policyNoticeRevision = 0;
let policyNoticePending = 0;
let enforcementConfigVersion = 0;
const transcript = "Synthetic private audio transcript";
const pendingTitle = "Pending isolation discussion";
const pendingText = "Synthetic reviewhold text from A";
const billing = { fullName: "Alice Isolation", email: "alice.isolation@example.test", country: "US", addressLine1: "123 Example Street", city: "Example", postalCode: "12345" };

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
// `offerPublicId` names an administrator-defined cart suggestion (catalogue-like, not owned by a customer);
// accepting or dismissing one only ever touches the caller's own cart.
const NOT_A_FOREIGN_RESOURCE = new Set(["recoverySetId", "challengeId", "upToMessageId", "productPublicId", "offerPublicId"]);

/** Every probe customer B runs, keyed by procedure path. Inputs are otherwise valid so only ownership decides. */
type Probe = { kind: "query" | "mutation"; input: () => unknown; denial?: { code: "FORBIDDEN"; reason: string } | { code: "FILTERED" }; alternateInputs?: () => unknown[] };

const documentLocator = (orderPublicId = owned.orderId) => ({ orderPublicId, filePublicId: owned.documentFileId });

function probes(): Record<string, Probe> {
  const o = owned;
  const key = (tag: string) => `isolation-${tag}-0000000000`;
  const consoleOnly = { code: "FORBIDDEN", reason: "ROLE_NOT_PERMITTED" } as const;
  const capabilityOnly = { code: "FORBIDDEN", reason: "CAPABILITY_NOT_GRANTED" } as const;
  const productionOrder = "integrations.production.order";
  const policyNotices = "compliance.policies.notices";
  const enforcement = "compliance.policies.enforcement";
  const policyDocument = () => ({ documentPublicId: o.enforcementDocumentId });
  const notice = () => ({ noticePublicId: o.policyNoticeId, revision: policyNoticeRevision });
  const noticeAudience = () => ({ ...notice(), confirmedCount: policyNoticePending });
  const enforcementTarget = () => ({ userPublicId: o.customerPublicId, versionPublicId: o.enforcementVersionId });
  return {
    "orders.get": { kind: "query", input: () => ({ orderId: o.orderId }) },
    // Pricing "for a customer" is a console action: a customer naming another customer is refused before any lookup.
    "orders.quote": {
      kind: "query", input: () => ({ items: [{ productPublicId: o.productId, quantity: 1 }], forCustomerPublicId: o.customerPublicId }),
      denial: { code: "FORBIDDEN", reason: "CAPABILITY_NOT_GRANTED" },
    },
    "orders.quoteWithPromo": {
      kind: "mutation", input: () => ({ items: [{ productPublicId: o.productId, quantity: 1 }], promoCode: "ISOLATION-PROBE", forCustomerPublicId: o.customerPublicId }),
      denial: { code: "FORBIDDEN", reason: "CAPABILITY_NOT_GRANTED" },
    },
    "orders.console.rename": {
      kind: "mutation", input: () => ({ orderId: o.orderId, expectedVersion: aOrderVersion, name: "Not my order" }),
      denial: { code: "FORBIDDEN", reason: "ROLE_NOT_PERMITTED" },
    },
    "audit.orderActivity": { kind: "query", input: () => ({ orderPublicId: o.orderId, category: "details", limit: 1 }) },
    "audit.orderStatusHistory": { kind: "query", input: () => ({ orderPublicId: o.orderId, limit: 2 }) },
    [`${productionOrder}.preview`]: { kind: "query", input: () => ({ orderPublicId: o.orderId }), denial: consoleOnly },
    [`${productionOrder}.history`]: { kind: "query", input: () => ({ orderPublicId: o.orderId }), denial: consoleOnly },
    [`${productionOrder}.requestP101`]: { kind: "mutation", input: () => ({ orderPublicId: o.orderId }), denial: consoleOnly },
    [`${productionOrder}.requestP201`]: { kind: "mutation", input: () => ({ orderPublicId: o.orderId, phase1ArtifactsConfirmed: true }), denial: consoleOnly },
    [`${productionOrder}.requestP301`]: { kind: "mutation", input: () => ({ orderPublicId: o.orderId }), denial: consoleOnly },
    [`${productionOrder}.requestP401`]: { kind: "mutation", input: () => ({ orderPublicId: o.orderId }), denial: consoleOnly },
    [`${productionOrder}.retry`]: {
      kind: "mutation", input: () => ({ orderPublicId: o.orderId, dispatchPublicId: o.dispatchId }), denial: consoleOnly,
    },
    [`${productionOrder}.redeliver`]: {
      kind: "mutation", input: () => ({
        orderPublicId: o.orderId, dispatchPublicId: o.dispatchId,
        reason: "Synthetic test", confirmation: "REDELIVER", idempotencyKey: key("redeliver"),
      }),
      denial: consoleOnly,
    },
    [`${productionOrder}.resend`]: {
      kind: "mutation", input: () => ({ orderPublicId: o.orderId, phase: "P301", reason: "Synthetic later-phase test" }), denial: consoleOnly,
    },
    "automations.orderStageActions.get": { kind: "query", input: () => ({ orderPublicId: o.orderId, runLimit: 2 }), denial: consoleOnly },
    "automations.orderStageActions.listRuns": { kind: "query", input: () => ({ orderPublicId: o.orderId, limit: 2 }), denial: consoleOnly },
    "automations.orderStageActions.runForOrder": {
      kind: "mutation", input: () => ({ orderPublicId: o.orderId, stepKey: "submitted", idempotencyKey: key("stage") }), denial: consoleOnly,
    },
    "automations.runs.list": { kind: "query", input: () => ({ orderPublicId: o.orderId, limit: 2 }), denial: consoleOnly },
    "orders.summary": { kind: "query", input: () => ({ orderId: o.orderId }) },
    "orders.update": { kind: "mutation", input: () => ({ orderId: o.orderId, expectedVersion: 1, projectName: "Hijacked" }) },
    "orders.addNote": { kind: "mutation", input: () => ({ orderId: o.orderId, body: "Not my order." }) },
    "orders.transition": { kind: "mutation", input: () => ({ orderId: o.orderId, expectedVersion: 1, toStatus: "cancelled" }) },
    "orders.sharing.list": { kind: "query", input: () => ({ orderId: o.orderId }) },
    "orders.sharing.invite": { kind: "mutation", input: () => ({ orderId: o.orderId, email: "intruder@example.test", role: "viewer" }) },
    "orders.sharing.revoke": { kind: "mutation", input: () => ({ orderId: o.orderId, grantId: o.grantId }) },
    "orders.sharing.respond": { kind: "mutation", input: () => ({ grantId: o.grantId, accept: true }) },
    "orders.requirements.forOrder": { kind: "query", input: () => ({ orderId: o.orderId }) },
    "orders.requirements.acknowledge": { kind: "mutation", input: () => ({ orderId: o.orderId, statusKey: "submitted", ackKey: "terms", textSha256: o.ackHash, typedName: "Bob Isolation" }) },
    "files.list": { kind: "query", input: () => ({ orderId: o.orderId }) },
    "files.issueDownloadTicket": { kind: "mutation", input: () => ({ fileId: o.fileId }) },
    "files.readTranscript": { kind: "mutation", input: () => ({ fileId: o.fileId }) },
    "files.recording.preflight": { kind: "query", input: () => ({ orderPublicId: o.orderId, slotKey: "voice_evidence" }) },
    "files.document.status": { kind: "query", input: () => documentLocator(), alternateInputs: () => [documentLocator(bOrderId)] },
    "files.document.versions": { kind: "query", input: () => documentLocator(), alternateInputs: () => [documentLocator(bOrderId)] },
    "storage.copies.forOrder": {
      kind: "query", input: () => ({ orderPublicId: o.orderId }), denial: { code: "FORBIDDEN", reason: "ROLE_NOT_PERMITTED" },
    },
    "storage.copies.retryOrderFile": {
      kind: "mutation", input: () => ({ orderPublicId: o.orderId, publicId: o.copyAttemptId }),
      denial: { code: "FORBIDDEN", reason: "ROLE_NOT_PERMITTED" },
    },
    "storage.copies.list": { kind: "query", input: () => ({ orderPublicId: o.orderId, limit: 2 }), denial: consoleOnly },
    // Community categories are shared. Listing must omit A's pending content; creating in a
    // visible staff-only category must fail its capability check, not hide the category.
    "community.topics.list": { kind: "query", input: () => ({ categoryPublicId: o.categoryId }), denial: { code: "FILTERED" } },
    "community.topics.get": { kind: "query", input: () => ({ topicPublicId: o.topicId }) },
    "community.topics.create": { kind: "mutation", input: () => ({ categoryPublicId: o.staffCategoryId, title: "Not a staff topic", body: "Not permitted.", idempotencyKey: key("topic") }), denial: { code: "FORBIDDEN", reason: "COMMUNITY_STAFF_ONLY_CATEGORY" } },
    "community.posts.reply": {
      kind: "mutation", input: () => ({ topicPublicId: o.topicId, body: "Not my pending topic.", idempotencyKey: key("reply-topic") }),
      alternateInputs: () => [{ topicPublicId: o.sharedTopicId, quotePostPublicId: o.postId, body: "Not my pending post.", idempotencyKey: key("reply-quote") }],
    },
    "community.posts.edit": { kind: "mutation", input: () => ({ postPublicId: o.postId, expectedVersion: 1, body: "Not my pending post." }) },
    "community.posts.delete": { kind: "mutation", input: () => ({ postPublicId: o.postId }) },
    "community.posts.react": { kind: "mutation", input: () => ({ postPublicId: o.postId, helpful: true }) },
    "community.posts.report": { kind: "mutation", input: () => ({ postPublicId: o.postId, reason: "spam" }) },
    "community.subscriptions.set": { kind: "mutation", input: () => ({ topicPublicId: o.topicId, subscribed: true }) },
    "cart.updateItem": { kind: "mutation", input: () => ({ itemPublicId: o.cartItemId, expectedVersion: cartVersion, quantity: 2 }) },
    "cart.removeItem": { kind: "mutation", input: () => ({ itemPublicId: o.cartItemId, expectedVersion: cartVersion }) },
    "cart.checkout": { kind: "mutation", input: () => ({ cartPublicId: o.cartId, expectedVersion: cartVersion, projectName: "Not my checkout", billing, idempotencyKey: key("checkout") }) },
    "cart.checkoutStatus": { kind: "query", input: () => ({ cartPublicId: o.checkedOutCartId }), alternateInputs: () => [{ attemptPublicId: o.attemptId }] },
    "cart.restoreCheckout": { kind: "mutation", input: () => ({ cartPublicId: o.checkedOutCartId }), alternateInputs: () => [{ attemptPublicId: o.attemptId }] },
    // Knowledge has audience and capability boundaries, not customer-owned articles.
    "knowledge.help.submitFeedback": { kind: "mutation", input: () => ({ articlePublicId: o.staffArticleId, helpful: true }) },
    "knowledge.attachments.issueDownloadTicket": { kind: "mutation", input: () => ({ attachmentPublicId: o.staffAttachmentId }) },
    "knowledge.attachments.remove": { kind: "mutation", input: () => ({ attachmentPublicId: o.staffAttachmentId }), denial: { code: "FORBIDDEN", reason: "CAPABILITY_NOT_GRANTED" } },
    "payments.startInvoiceCheckout": { kind: "mutation", input: () => ({ invoicePublicId: o.paymentInvoiceId, idempotencyKey: key("payment") }) },
    "payments.checkoutStatus": { kind: "query", input: () => ({ invoicePublicId: o.paymentInvoiceId }), alternateInputs: () => [{ attemptPublicId: o.attemptId }] },
    "payments.cancelAttempt": { kind: "mutation", input: () => ({ invoicePublicId: o.paymentInvoiceId }), alternateInputs: () => [{ attemptPublicId: o.attemptId }] },
    "payments.refunds.forOrder": {
      kind: "query", input: () => ({ orderPublicId: o.orderId }), denial: { code: "FORBIDDEN", reason: "ROLE_NOT_PERMITTED" },
    },
    "payments.refunds.create": {
      kind: "mutation", input: () => ({
        orderPublicId: o.orderId, paymentPublicId: o.refundPaymentId, amountMinor: 100, currency: "USD",
        reason: "Synthetic isolation review", confirmationPhrase: "REFUND ORDER", sendCustomerNotice: false,
        idempotencyKey: key("refund"),
      }),
      denial: consoleOnly,
    },
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
    "compliance.receipts.forOrder": { kind: "query", input: () => ({ orderPublicId: o.orderId }) },
    "compliance.receipts.get": { kind: "query", input: () => ({ receiptPublicId: o.paymentReceiptId }) },
    "identity.sessions.revoke": { kind: "mutation", input: () => ({ sessionId: o.sessionId }) },
    // Unknown-id probes (README: a cross-account passkey fixture is it.todo).
    "assurance.renamePasskey": { kind: "mutation", input: () => ({ publicId: o.orderId, name: "Intruder key" }) },
    "assurance.removePasskey": { kind: "mutation", input: () => ({ publicId: o.orderId }) },
    "compliance.policies.accept": {
      kind: "mutation", input: () => ({ versionPublicId: o.policyVersionId, contentHash: o.policyHash, orderPublicId: o.orderId }),
    },
    [`${policyNotices}.status`]: { kind: "query", input: policyDocument, denial: capabilityOnly },
    [`${policyNotices}.setDelay`]: {
      kind: "mutation", input: () => ({ ...policyDocument(), delayHours: 6 }), denial: capabilityOnly,
    },
    [`${policyNotices}.reschedule`]: {
      kind: "mutation", input: () => ({ ...notice(), scheduledAt: new Date(sys.clock.now().getTime() + 3_600_000) }), denial: capabilityOnly,
    },
    [`${policyNotices}.cancel`]: { kind: "mutation", input: notice, denial: capabilityOnly },
    [`${policyNotices}.sendNow`]: { kind: "mutation", input: noticeAudience, denial: capabilityOnly },
    [`${policyNotices}.remind`]: { kind: "mutation", input: noticeAudience, denial: capabilityOnly },
    [`${enforcement}.status`]: { kind: "query", input: policyDocument, denial: capabilityOnly },
    [`${enforcement}.configure`]: {
      kind: "mutation", input: () => ({
        ...policyDocument(), expectedVersion: enforcementConfigVersion, mode: "none", graceHours: 24, warningText: null,
      }), denial: capabilityOnly,
    },
    [`${enforcement}.forTarget`]: { kind: "query", input: enforcementTarget, denial: capabilityOnly },
    [`${enforcement}.endNow`]: { kind: "mutation", input: enforcementTarget, denial: capabilityOnly },
    // A version is shared, but A's pending enforcement item is not. B already accepted this version.
    [`${enforcement}.decline`]: { kind: "mutation", input: () => ({ versionPublicId: o.enforcementVersionId }) },
    // Acceptance has no target user field; a real staff-only version is outside B's audience.
    [`${enforcement}.accept`]: {
      kind: "mutation", input: () => ({ versionPublicId: o.staffPolicyVersionId, contentHash: o.staffPolicyHash }),
    },
    "compliance.acceptance.forOrder": { kind: "query", input: () => ({ orderId: o.orderId }) },
    "compliance.acceptance.accept": {
      kind: "mutation", input: () => ({ orderId: o.orderId, gateKey, policyVersionId: o.policyVersionId, textSha256: o.policyHash }),
    },
    "compliance.acceptance.receipt": { kind: "query", input: () => ({ receiptId: o.receiptId }) },
    "compliance.acceptance.console.count": {
      kind: "query", input: () => ({ orderId: o.orderId }), denial: { code: "FORBIDDEN", reason: "ROLE_NOT_PERMITTED" },
    },
    "compliance.acceptance.console.list": {
      kind: "query", input: () => ({ orderId: o.orderId }), denial: { code: "FORBIDDEN", reason: "ROLE_NOT_PERMITTED" },
    },
  };
}

async function call(browser: Browser, kind: "query" | "mutation", path: string, input: unknown): Promise<TrpcResult> {
  if (kind === "query") return browser.query(path, input);
  if (path !== "compliance.policies.notices.reschedule") return browser.mutate(path, input);
  // The harness's generic mutation helper only wraps JSON; this route takes a SuperJSON Date.
  const res = await browser.raw("post", `/api/trpc/${path}`).send(superjson.serialize(input));
  return { res, status: res.status, requestId: String(res.headers["x-request-id"]),
    data: res.body?.result?.data?.json, error: res.body?.error?.json?.data };
}

async function installRequirementsWorkflow(policyPublicId: string) {
  const workflow = "orders.admin.workflows.drafts";
  const name = "Isolation workflow";
  const { publicId } = Browser.ok(await admin.browser.mutate<{ publicId: string }>(`${workflow}.create`, { from: "blank", workflowKey: "isolation_flow", name }));
  Browser.ok(await admin.browser.mutate(`${workflow}.save`, {
    draftId: publicId, expectedVersion: 1, name,
    definition: {
      acceptanceGates: [{ key: gateKey, policyPublicId, point: "order_start", signatureMode: "checkbox", askAgainOnNewVersion: false }],
      phases: [{ key: "intake", label: "Intake" }],
      states: [
        {
          key: "submitted", label: "Submitted", customerLabel: "Submitted", kind: "initial", tone: "info", phase: "intake",
          requirements: {
            uploads: [{ key: "voice_evidence", label: "Voice evidence", kind: "audio", minCount: 1, maxCount: 2, allowedTypes: ["wav"], uploadedBy: ["customer"] }],
            acknowledgements: [{ key: "terms", title: "Project terms", body: "I confirm the brief is complete.", acceptedBy: "customer", requireTypedName: true }],
          },
        },
        { key: "completed", label: "Completed", customerLabel: "Completed", kind: "terminal", tone: "success", phase: "intake" },
        { key: "canceled", label: "Canceled", customerLabel: "Canceled", kind: "terminal", tone: "neutral" },
      ],
      transitions: [
        { from: "submitted", to: "completed", allowedBy: ["staff", "admin"], notifyCustomer: true, requiresNote: false },
        { from: "submitted", to: "canceled", allowedBy: ["customer", "staff", "admin"], notifyCustomer: true, requiresNote: false },
      ],
    },
  }));
  Browser.ok(await admin.browser.mutate(`${workflow}.publish`, { draftId: publicId, expectedVersion: 2, makeDefault: true }));
}

async function publishPolicy(slug: string, title: string, audience: "customer" | "staff", requiresAcceptance: boolean) {
  const policyAdmin = "compliance.policies.admin";
  const policy = Browser.ok(await admin.browser.mutate<{
    documentPublicId: string; draftVersionPublicId: string; contentHash: string;
  }>(`${policyAdmin}.createDocument`, {
    slug, title, audience, requiresAcceptance, requiresTypedSignature: false, versionLabel: "1.0",
    contentFormat: "plain_text", bodyText: "Synthetic policy used by the isolation suite.",
  }));
  Browser.ok(await admin.browser.mutate(`${policyAdmin}.publishVersion`, { versionPublicId: policy.draftVersionPublicId }));
  return policy;
}

async function seedPolicyEnforcement() {
  const staffPolicy = await publishPolicy("isolation-staff-policy", "Staff isolation policy", "staff", false);
  owned.staffPolicyVersionId = staffPolicy.draftVersionPublicId;
  owned.staffPolicyHash = staffPolicy.contentHash;

  const policy = await publishPolicy("isolation-enforcement-policy", "Enforcement isolation policy", "customer", true);
  owned.enforcementDocumentId = policy.documentPublicId;
  owned.enforcementVersionId = policy.draftVersionPublicId;
  // B can accept the shared version for itself. This must not satisfy A's separate obligation.
  Browser.ok(await b.browser.mutate("compliance.policies.enforcement.accept", {
    versionPublicId: owned.enforcementVersionId, contentHash: policy.contentHash,
  }));

  const document = { documentPublicId: owned.enforcementDocumentId };
  const { notice } = Browser.ok(await admin.browser.query<{
    notice: { publicId: string; revision: number; pending: number; state: string };
  }>("compliance.policies.notices.status", document));
  expect(notice).toMatchObject({ state: "scheduled", pending: 1 });
  ({ publicId: owned.policyNoticeId, revision: policyNoticeRevision, pending: policyNoticePending } = notice);

  const status = Browser.ok(await admin.browser.query<{
    expectedVersion: number; affectedCount: number;
  }>("compliance.policies.enforcement.status", document));
  expect(status.affectedCount).toBe(1);
  ({ version: enforcementConfigVersion } = Browser.ok(await admin.browser.mutate<{ version: number }>(
    "compliance.policies.enforcement.configure", {
      ...document, expectedVersion: status.expectedVersion, mode: "required_to_continue", graceHours: 24,
      warningText: null, confirmedCount: status.affectedCount,
    },
  )));
}

async function seedCommunity() {
  const addCategory = async (slug: string, name: string, staffOnlyPosting: boolean) => Browser.ok(
    await admin.browser.mutate<{ publicId: string }>("community.admin.categories.create", { slug, name, staffOnlyPosting }),
  ).publicId;
  owned.categoryId = await addCategory("isolation", "Isolation forum", false);
  owned.staffCategoryId = await addCategory("staff-announcements", "Staff announcements", true);
  Browser.ok(await a.browser.mutate("community.profile.save", { displayName: "Alice Isolation" }));
  Browser.ok(await b.browser.mutate("community.profile.save", { displayName: "Bob Isolation" }));
  const makeTopic = async (title: string, body: string, idempotencyKey: string) => Browser.ok(
    await a.browser.mutate<{ topicPublicId: string; postPublicId: string; state: string }>("community.topics.create", { categoryPublicId: owned.categoryId, title, body, idempotencyKey }),
  );
  const pending = await makeTopic(pendingTitle, pendingText, "isolation-pending-topic");
  expect(pending.state).toBe("pending");
  owned.topicId = pending.topicPublicId;
  owned.postId = pending.postPublicId;
  const shared = await makeTopic("Shared isolation discussion", "Synthetic text meant for all members.", "isolation-shared-topic");
  expect(shared.state).toBe("published");
  owned.sharedTopicId = shared.topicPublicId;
}

async function seedCartAndAttempt(productId: string, userId: number) {
  const add = async () => Browser.ok(await a.browser.mutate<CartView>("cart.addItems", { items: [{ productPublicId: productId, quantity: 1 }] }));
  const original = await add();
  const checkedOut = Browser.ok(await a.browser.mutate<CheckoutCartResult>("cart.checkout", {
    cartPublicId: original.cartPublicId, expectedVersion: original.version, projectName: "Owned checkout A", billing, idempotencyKey: "isolation-cart-checkout-a",
  }));
  expect(checkedOut.mode).toBe("invoice");
  owned.checkedOutCartId = checkedOut.cartPublicId;
  owned.paymentInvoiceId = checkedOut.invoicePublicId;
  const current = await add();
  owned.cartId = current.cartPublicId ?? "";
  owned.cartItemId = current.items[0]?.itemPublicId ?? "";
  cartVersion = current.version;

  // Insert an attempt for A's real issued invoice. The assembled app must not call a live provider.
  const [invoice] = await sys.t.db.select().from(complianceInvoices).where(eq(complianceInvoices.publicId, checkedOut.invoicePublicId));
  const idempotencyKey = "isolation-hosted-attempt";
  await sys.t.db.insert(paymentAttempts).values({
    invoiceId: invoice!.id, invoicePublicId: checkedOut.invoicePublicId, cartPublicId: checkedOut.cartPublicId,
    orderPublicId: checkedOut.orderPublicId, customerUserId: userId, provider: "stripe", environment: "test",
    amountMinor: checkedOut.totalMinor, currency: checkedOut.currency, idempotencyKey, status: "created",
    successPath: "/checkout/return", cancelPath: "/cart",
  });
  const [attempt] = await sys.t.db.select().from(paymentAttempts).where(eq(paymentAttempts.idempotencyKey, idempotencyKey));
  owned.attemptId = attempt!.publicId;
  await sys.t.db.update(carts).set({ paymentAttemptPublicId: owned.attemptId }).where(eq(carts.publicId, owned.checkedOutCartId));
}

async function seedKnowledge(adminUserId: number) {
  const category = Browser.ok(await admin.browser.mutate<{ publicId: string }>("knowledge.admin.categories.create", { slug: "isolation-help", title: "Isolation help" }));
  const [row] = await sys.t.db.select().from(knowledgeCategories).where(eq(knowledgeCategories.publicId, category.publicId));
  const slug = "isolation-staff-article";
  await sys.t.db.insert(knowledgeArticles).values({
    categoryId: row!.id, slug, title: "Staff-only material", summary: "Internal use", bodyHtml: "<p>Staff only.</p>", bodyText: "Staff only.",
    tagsJson: "[]", audience: "staff", state: "published", publishedAt: sys.clock.now(), authorUserId: adminUserId, updatedByUserId: adminUserId,
  });
  const [article] = await sys.t.db.select().from(knowledgeArticles).where(eq(knowledgeArticles.slug, slug));
  owned.staffArticleId = article!.publicId;
  const storageKey = `files/${"2".repeat(32)}`;
  await sys.t.db.insert(knowledgeArticleAttachments).values({
    articleId: article!.id, uploadedByUserId: adminUserId, storageKey, displayNameEnc: "unused-by-ticket-issuance",
    byteSize: 20, sha256: "a".repeat(64), contentType: "application/pdf", extension: "pdf",
  });
  const [attachment] = await sys.t.db.select().from(knowledgeArticleAttachments).where(eq(knowledgeArticleAttachments.storageKey, storageKey));
  owned.staffAttachmentId = attachment!.publicId;
}

async function seedOrderCopyAndPayment() {
  const jobPublicId = "synthetic-isolation-copy-job";
  await sys.t.db.insert(storageCopyAttempts).values({
    kind: "order_file", sourcePublicId: owned.fileId, orderPublicId: owned.orderId,
    connectionPublicId: owned.orderId, jobPublicId, attempt: 1, state: "failed",
  });
  const [copy] = await sys.t.db.select().from(storageCopyAttempts).where(eq(storageCopyAttempts.jobPublicId, jobPublicId));
  owned.copyAttemptId = copy!.publicId;

  const payment = Browser.ok(await admin.browser.mutate<{ paymentPublicId: string }>("compliance.invoices.admin.recordManualPayment", {
    invoicePublicId: owned.invoiceId, method: "check", amountMinor: 1500, currency: "USD",
    reference: "Synthetic manual payment", idempotencyKey: "synthetic-isolation-manual-payment",
  }));
  owned.refundPaymentId = payment.paymentPublicId;
  const receipts = Browser.ok(await a.browser.query<{ receiptPublicId: string }[]>("compliance.receipts.forOrder", { orderPublicId: owned.orderId }));
  expect(receipts).toHaveLength(1);
  owned.paymentReceiptId = receipts[0]!.receiptPublicId;
}

async function seedProductionDispatch(ownerUserId: number) {
  const [order] = await sys.t.db.select().from(orders).where(eq(orders.publicId, owned.orderId));
  const idempotencyKey = "synthetic-isolation-dispatch";
  await sys.t.db.insert(integrationProductionDispatches).values({
    orderId: order!.id, orderPublicId: owned.orderId, orderReference: order!.reference, expectedOwnerUserId: ownerUserId,
    destinationFingerprint: "a".repeat(64), payloadSha256: "b".repeat(64), jobPublicId: "synthetic-isolation-dispatch-job",
    expiresAt: sys.clock.now(), phase: "P101", state: "delivered", idempotencyKey,
    sentCustomerId: "synthetic-customer", sentOrderId: "synthetic-order", sentRunMode: "test",
    deliveredAt: sys.clock.now(), correlationId: "synthetic-isolation-correlation",
  });
  const [dispatch] = await sys.t.db.select().from(integrationProductionDispatches).where(eq(integrationProductionDispatches.idempotencyKey, idempotencyKey));
  owned.dispatchId = dispatch!.publicId;
}

beforeAll(async () => {
  sys = await createSystem();
  admin = await bootstrapAdmin(sys);
  const { settings } = sys.container.services;
  if (!isPlatformSettingsStore(settings)) throw new Error("Expected the assembled settings store");
  await settings.set("orders.workflow_rules.enabled", true);
  await settings.set("files.audio_conversion", { enabled: true, maxMinutes: 1, bitrateKbps: 48, keepOriginal: true });
  await settings.set("community.config", { ...DEFAULT_COMMUNITY_CONFIG, newMemberReviewPosts: 0, heldWords: ["reviewhold"] });
  for (const feature of ["community", "cart", "knowledge"]) await settings.setFeature(feature, true);
  Browser.ok(await stepUp(sys, admin.browser, admin.password, admin.secret));
  const gatePolicy = await publishPolicy("isolation-project-policy", "Isolation project policy", "customer", false);
  owned.policyVersionId = gatePolicy.draftVersionPublicId;
  owned.policyHash = gatePolicy.contentHash;
  await installRequirementsWorkflow(gatePolicy.documentPublicId);
  const productId = await seedProduct(admin);
  owned.productId = productId;
  a = await registerCustomer(sys, "alice.isolation@example.test", "Alice Isolation");
  b = await registerCustomer(sys, "bob.isolation@example.test", "Bob Isolation");
  owned.customerPublicId = Browser.ok(await a.browser.query<{ user: { publicId: string } }>("identity.me")).user.publicId;

  const order = Browser.ok(await a.browser.mutate<{ publicId: string }>("orders.create", {
    projectName: owned.projectName, items: [{ productPublicId: productId, quantity: 1 }], idempotencyKey: "isolation-order-a-0001",
  }));
  owned.orderId = order.publicId;
  Browser.ok(await a.browser.mutate("orders.addNote", { orderId: owned.orderId, body: "Private note of A." }));
  const acceptance = Browser.ok(await a.browser.mutate<{ receipt: { receiptId: string } }>("compliance.acceptance.accept", {
    orderId: owned.orderId, gateKey, policyVersionId: owned.policyVersionId, textSha256: owned.policyHash,
  }));
  owned.receiptId = acceptance.receipt.receiptId;
  bOrderId = Browser.ok(await b.browser.mutate<{ publicId: string }>("orders.create", {
    projectName: "Isolation project bravo", items: [{ productPublicId: productId, quantity: 1 }], idempotencyKey: "isolation-order-b-0001",
  })).publicId;

  const upload = await a.browser.raw("post", `/api/files/upload/${owned.orderId}?statusKey=submitted&slotKey=voice_evidence`)
    .field("transcript", transcript).attach("files", exampleWav(8000), "private.wav");
  expect(upload.status).toBe(200);
  owned.fileId = upload.body.results[0].file.publicId as string;
  const document = await a.browser.raw("post", `/api/files/upload/${owned.orderId}`)
    .attach("files", exampleDocx(), "private.docx");
  expect(document.status).toBe(200);
  expect(document.body.results[0]).toMatchObject({ outcome: "completed", file: { extension: "docx" } });
  owned.documentFileId = document.body.results[0].file.publicId as string;
  const { acknowledgements } = Browser.ok(await a.browser.query<{ acknowledgements: { key: string; textSha256: string; canAccept: boolean }[] }>("orders.requirements.forOrder", { orderId: owned.orderId }));
  expect(acknowledgements).toEqual([expect.objectContaining({ key: "terms", canAccept: true })]);
  owned.ackHash = acknowledgements[0]!.textSha256;

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

  await seedCommunity();
  await seedCartAndAttempt(productId, aUser!.userId);
  const adminUser = await sys.container.services.identity.findUserIdByEmail(admin.email);
  await seedKnowledge(adminUser!.userId);
  await seedOrderCopyAndPayment();
  await seedProductionDispatch(aUser!.userId);
  await seedPolicyEnforcement();
  ({ version: aOrderVersion } = Browser.ok(await a.browser.query<{ version: number }>("orders.get", { orderId: owned.orderId })));

  for (const [name, value] of Object.entries(owned)) expect(value, name).not.toBe("");
}, 120_000);

afterAll(async () => sys?.close());

describe("cross-customer isolation (assembled system)", () => {
  it("customer A can read every one of its own resources (the probes below are meaningful)", async () => {
    Browser.ok(await a.browser.query("orders.get", { orderId: owned.orderId }));
    Browser.ok(await a.browser.query("engagement.tickets.get", { ticketId: owned.ticketId }));
    Browser.ok(await a.browser.query("audit.orderActivity", { orderPublicId: owned.orderId, category: "details" }));
    expect(Browser.ok(await a.browser.query("audit.orderStatusHistory", { orderPublicId: owned.orderId }))).toMatchObject({ view: "customer" });
    expect(Browser.ok(await a.browser.query("compliance.acceptance.forOrder", { orderId: owned.orderId }))).toMatchObject({ blocking: false });
    expect(Browser.ok(await a.browser.query("compliance.acceptance.receipt", { receiptId: owned.receiptId }))).toMatchObject({ receiptId: owned.receiptId });
    expect(Browser.ok(await admin.browser.query("compliance.acceptance.console.count", { orderId: owned.orderId }))).toEqual({ total: 1 });
    expect(Browser.ok(await admin.browser.query("compliance.acceptance.console.list", { orderId: owned.orderId }))).toMatchObject({
      items: [expect.objectContaining({ receiptId: owned.receiptId })],
    });
    expect(Browser.ok(await admin.browser.query("payments.refunds.forOrder", { orderPublicId: owned.orderId }))).toMatchObject({
      payments: expect.arrayContaining([expect.objectContaining({ paymentPublicId: owned.refundPaymentId })]),
    });
    Browser.ok(await a.browser.mutate("compliance.policies.accept", { versionPublicId: owned.policyVersionId, contentHash: owned.policyHash, orderPublicId: owned.orderId }));
    Browser.ok(await a.browser.query("compliance.invoices.get", { invoicePublicId: owned.invoiceId }));
    expect(Browser.ok(await a.browser.query("compliance.receipts.get", { receiptPublicId: owned.paymentReceiptId })))
      .toMatchObject({ receiptPublicId: owned.paymentReceiptId });
    expect(Browser.ok(await a.browser.query("files.recording.preflight", { orderPublicId: owned.orderId, slotKey: "voice_evidence" })))
      .toMatchObject({ acceptedTypes: ["wav"] });
    expect(Browser.ok(await a.browser.query("files.document.status", documentLocator())))
      .toMatchObject({ file: { publicId: owned.documentFileId } });
    expect(Browser.ok(await a.browser.query("files.document.versions", documentLocator())))
      .toEqual([expect.objectContaining({ publicId: owned.documentFileId })]);
    expect(Browser.ok(await a.browser.query("compliance.policies.enforcement.pending")))
      .toEqual([expect.objectContaining({ versionPublicId: owned.enforcementVersionId })]);
    expect(Browser.ok(await b.browser.query("compliance.policies.enforcement.pending"))).toEqual([]);
    expect(Browser.ok(await admin.browser.query("compliance.policies.enforcement.forTarget", {
      userPublicId: owned.customerPublicId, versionPublicId: owned.enforcementVersionId,
    }))).toEqual({ canEndSessions: true });
    Browser.ok(await a.browser.mutate("files.issueDownloadTicket", { fileId: owned.fileId }));
    expect(Browser.ok(await a.browser.mutate("files.readTranscript", { fileId: owned.fileId }))).toEqual({ transcript });
    expect(Browser.ok(await a.browser.query("community.topics.get", { topicPublicId: owned.topicId }))).toEqual(expect.objectContaining({
      topic: expect.objectContaining({ publicId: owned.topicId, title: pendingTitle }),
      posts: expect.arrayContaining([expect.objectContaining({ publicId: owned.postId })]),
    }));
    expect(Browser.ok(await a.browser.query<CartView>("cart.get")).items).toEqual([expect.objectContaining({ itemPublicId: owned.cartItemId, quantity: 1 })]);
    Browser.ok(await a.browser.query("cart.checkoutStatus", { attemptPublicId: owned.attemptId }));
    Browser.ok(await a.browser.query("payments.checkoutStatus", { attemptPublicId: owned.attemptId }));
    Browser.ok(await a.browser.mutate("payments.startInvoiceCheckout", { invoicePublicId: owned.paymentInvoiceId }));
    Browser.ok(await admin.browser.mutate("knowledge.attachments.issueDownloadTicket", { attachmentPublicId: owned.staffAttachmentId }));
  });

  it("customer B cannot read or mutate protected resources through any by-id procedure", async () => {
    // B is fully stepped-up, so a freshness gate can never mask a missing ownership check.
    Browser.ok(await stepUp(sys, b.browser, STRONG_PASSWORD, b.secret));
    const failures: string[] = [];
    for (const [path, probe] of Object.entries(probes())) {
      const inputs = [probe.input(), ...(probe.alternateInputs?.() ?? [])];
      for (const [index, input] of inputs.entries()) {
        const result = await call(b.browser, probe.kind, path, input);
        const code = result.error?.safe.domainCode;
        const reason = result.error?.safe.reasonCode;
        const label = `${path}${inputs.length > 1 ? ` #${index + 1}` : ""}`;
        if (probe.denial?.code === "FILTERED") {
          const visible = JSON.stringify(Browser.ok(result));
          for (const privateValue of [owned.topicId, owned.postId, pendingTitle, pendingText]) {
            if (visible.includes(privateValue)) failures.push(`${label}: returned private community content`);
          }
          if (!visible.includes(owned.sharedTopicId)) failures.push(`${label}: did not return the shared topic`);
        } else if (probe.denial?.code === "FORBIDDEN") {
          if (result.status !== 403 || code !== "FORBIDDEN" || reason !== probe.denial.reason) failures.push(`${label}: ${result.status} ${code ?? ""} ${reason ?? ""}`);
        } else if (result.status !== 404 || code !== "NOT_FOUND") {
          failures.push(`${label}: ${result.status} ${code ?? ""} ${reason ?? ""}`);
        }
      }
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

  it("staff sees the transfer in its order only and cannot target it through a second order", async () => {
    const first = Browser.ok(await admin.browser.query("storage.copies.forOrder", { orderPublicId: owned.orderId }));
    expect(JSON.stringify(first)).toContain(owned.copyAttemptId);
    const second = Browser.ok(await admin.browser.query("storage.copies.forOrder", { orderPublicId: bOrderId }));
    expect(JSON.stringify(second)).not.toContain(owned.copyAttemptId);
    const cursor = await admin.browser.query("storage.copies.forOrder", { orderPublicId: bOrderId, cursor: owned.copyAttemptId });
    expect(cursor.status).toBe(404);
    expect(cursor.error?.safe).toMatchObject({ domainCode: "NOT_FOUND", reasonCode: "COPY_ATTEMPT_NOT_FOUND" });
    const retry = await admin.browser.mutate("storage.copies.retryOrderFile", { orderPublicId: bOrderId, publicId: owned.copyAttemptId });
    expect(retry.status).toBe(409);
    expect(retry.error?.safe).toMatchObject({ domainCode: "CONFLICT", reasonCode: "COPY_RETRY_UNAVAILABLE" });
  });

  it("console production history shows only the selected order's dispatches", async () => {
    const first = Browser.ok(await admin.browser.query("integrations.production.order.history", { orderPublicId: owned.orderId }));
    expect(first).toMatchObject({ items: [expect.objectContaining({ publicId: owned.dispatchId })] });
    const second = Browser.ok(await admin.browser.query("integrations.production.order.history", { orderPublicId: bOrderId }));
    expect(second).toEqual({ items: [] });
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
    expect(Browser.ok(await a.browser.query("compliance.policies.enforcement.pending")))
      .toEqual([expect.objectContaining({ versionPublicId: owned.enforcementVersionId })]);
    expect(Browser.ok(await admin.browser.query("compliance.policies.enforcement.status", { documentPublicId: owned.enforcementDocumentId })))
      .toMatchObject({ expectedVersion: enforcementConfigVersion, mode: "required_to_continue" });
    expect(Browser.ok(await admin.browser.query("compliance.policies.notices.status", { documentPublicId: owned.enforcementDocumentId })))
      .toMatchObject({ delayHours: 24, notice: { publicId: owned.policyNoticeId, revision: policyNoticeRevision, state: "scheduled" } });
    const messages = JSON.stringify(Browser.ok(await a.browser.query("engagement.messages.listByOrder", { orderId: owned.orderId })));
    expect(messages).not.toContain("Intrusion.");
    const cart = Browser.ok(await a.browser.query<CartView>("cart.get"));
    expect(cart).toMatchObject({ cartPublicId: owned.cartId, version: cartVersion, items: [{ itemPublicId: owned.cartItemId, quantity: 1 }] });
    const [attempt] = await sys.t.db.select().from(paymentAttempts).where(eq(paymentAttempts.publicId, owned.attemptId));
    expect(attempt).toMatchObject({ status: "created", cancelledAt: null });
    const [attachment] = await sys.t.db.select().from(knowledgeArticleAttachments).where(eq(knowledgeArticleAttachments.publicId, owned.staffAttachmentId));
    expect(attachment?.deletedAt).toBeNull();
    const [article] = await sys.t.db.select().from(knowledgeArticles).where(eq(knowledgeArticles.publicId, owned.staffArticleId));
    expect(article).toMatchObject({ helpfulYesCount: 0, helpfulNoCount: 0 });
    Browser.ok(await a.browser.mutate("orders.requirements.acknowledge", { orderId: owned.orderId, statusKey: "submitted", ackKey: "terms", textSha256: owned.ackHash, typedName: "Alice Isolation" }));
  });

  it("renames with optimistic concurrency, preserves the reference, and redacts customer activity", async () => {
    const orderId = owned.orderId;
    const addr = "203.0.113.249";
    const supplied = "  Cafe\u0301 isolation  ";
    const expected = "Café isolation";
    const [before] = await sys.t.db.select({ id: orders.id, reference: orders.reference, version: orders.version }).from(orders).where(eq(orders.publicId, orderId));
    expect(before).toBeDefined();
    const denied = await a.browser.mutate("orders.console.rename", { orderId, expectedVersion: before!.version, name: expected });
    expect(denied.status).toBe(403);
    expect(denied.error?.safe).toMatchObject({ domainCode: "FORBIDDEN", reasonCode: "ROLE_NOT_PERMITTED" });
    const accepted = await admin.browser.mutate<{ version: number }>(
      "orders.console.rename", { orderId, expectedVersion: before!.version, name: supplied }, { address: addr },
    );
    expect(Browser.ok(accepted)).toMatchObject({ version: before!.version + 1 });
    const stale = await admin.browser.mutate("orders.console.rename", { orderId, expectedVersion: before!.version, name: "Stale rename" });
    expect(stale.status).toBe(409);
    expect(stale.error?.safe.domainCode).toBe("CONFLICT");
    const noOp = await admin.browser.mutate("orders.console.rename", { orderId, expectedVersion: before!.version + 1, name: supplied });
    expect(Browser.ok(noOp)).toEqual({ version: before!.version + 1, changed: false });
    for (const name of ["   ", "x".repeat(121), "in\u0000valid"]) {
      const invalid = await admin.browser.mutate("orders.console.rename", { orderId, expectedVersion: before!.version + 1, name });
      expect(invalid.status).toBe(400);
      expect(invalid.error?.safe.reasonCode).toBe("ORDER_NAME_INVALID");
    }
    const [after] = await sys.t.db.select({ reference: orders.reference, version: orders.version, name: orders.projectName }).from(orders).where(eq(orders.publicId, orderId));
    expect(after).toEqual({ reference: before!.reference, version: before!.version + 1, name: expected });
    const [event] = await sys.audit({ requestId: accepted.requestId, eventName: "order.renamed" });
    expect(event).toBeDefined();
    expect(event?.attributes).toMatchObject({ order_public_id: orderId, renamed: true, old_length: owned.projectName.length, new_length: expected.length });
    expect(JSON.stringify(event?.attributes)).not.toContain(owned.projectName);
    expect(JSON.stringify(event?.attributes)).not.toContain(expected);
    const names = await sys.t.db.select().from(orderNameHistory).where(eq(orderNameHistory.orderId, before!.id));
    expect(names).toEqual([expect.objectContaining({ oldName: owned.projectName, newName: expected, actorRole: "admin" })]);

    const staffHistory = Browser.ok(await admin.browser.query("audit.orderStatusHistory", { orderPublicId: orderId }));
    expect(staffHistory).toMatchObject({
      view: "staff", items: expect.arrayContaining([expect.objectContaining({
        kind: "rename", actor: "Ada Admin", oldName: owned.projectName, newName: expected,
      })]),
    });
    const customerHistory = Browser.ok(await a.browser.query("audit.orderStatusHistory", { orderPublicId: orderId }));
    expect(customerHistory).toMatchObject({
      view: "customer", items: expect.arrayContaining([expect.objectContaining({ kind: "rename", actor: "ReadyPackets staff" })]),
    });
    for (const privateValue of ["oldName", "newName", owned.projectName, expected, "Ada Admin", admin.email, addr, "actorUserId", "sourceAddress"]) {
      expect(JSON.stringify(customerHistory)).not.toContain(privateValue);
    }

    const input = { orderPublicId: orderId, category: "details", limit: 1 };
    const staff = Browser.ok(await admin.browser.query("audit.orderActivity", input));
    expect(staff).toMatchObject({
      view: "staff", items: [expect.objectContaining({ eventName: "order.renamed", actor: "Ada Admin", eventId: event!.eventId })],
    });
    const customer = Browser.ok(await a.browser.query<{ nextCursor: string | null }>("audit.orderActivity", input));
    expect(customer).toMatchObject({
      view: "customer", items: [expect.objectContaining({ label: "Order renamed", actor: "ReadyPackets staff", details: {} })],
      nextCursor: expect.any(String),
    });
    for (const privateValue of [event!.eventId, accepted.requestId, "Ada Admin", admin.email, addr, "actorUserId", "sourceAddress", owned.projectName, expected]) {
      expect(JSON.stringify(customer)).not.toContain(privateValue);
    }
    expect(Buffer.from(customer.nextCursor!, "base64url").toString("utf8")).not.toContain(event!.eventId);
    const second = Browser.ok(await a.browser.query("audit.orderActivity", { ...input, cursor: customer.nextCursor }));
    expect(second).toMatchObject({ view: "customer", items: [expect.objectContaining({ label: "Order created" })] });
    const wrongCategory = await a.browser.query("audit.orderActivity", { ...input, category: "files", cursor: customer.nextCursor });
    expect(wrongCategory.status).toBe(400);
    expect(wrongCategory.error?.safe.reasonCode).toBe("CURSOR_INVALID");
    const wrongCustomerOrder = await b.browser.query("audit.orderActivity", { ...input, orderPublicId: bOrderId, cursor: customer.nextCursor });
    expect(wrongCustomerOrder.status).toBe(400);
    expect(wrongCustomerOrder.error?.safe.reasonCode).toBe("CURSOR_INVALID");
    const invite = Browser.ok(await a.browser.mutate<{ publicId: string }>("orders.sharing.invite", {
      orderId, email: b.email, role: "contributor",
    }));
    Browser.ok(await b.browser.mutate("orders.sharing.respond", { grantId: invite.publicId, accept: true }));
    Browser.ok(await b.browser.query("orders.get", { orderId }));
    const sharedRename = await b.browser.mutate("orders.console.rename", {
      orderId, expectedVersion: before!.version + 1, name: "Contributor rename",
    });
    expect(sharedRename.status).toBe(403);
    expect(sharedRename.error?.safe).toMatchObject({ domainCode: "FORBIDDEN", reasonCode: "ROLE_NOT_PERMITTED" });
    const wrongReader = await b.browser.query("audit.orderActivity", { ...input, cursor: customer.nextCursor });
    expect(wrongReader.status).toBe(400);
    expect(wrongReader.error?.safe.reasonCode).toBe("CURSOR_INVALID");
    const statusPage = Browser.ok(await a.browser.query<{ nextCursor: string | null }>("audit.orderStatusHistory", {
      orderPublicId: orderId, limit: 1,
    }));
    expect(statusPage.nextCursor).toEqual(expect.any(String));
    for (const [browser, scope] of [[b.browser, orderId], [b.browser, bOrderId], [admin.browser, orderId]] as const) {
      const foreignCursor = await browser.query("audit.orderStatusHistory", { orderPublicId: scope, cursor: statusPage.nextCursor });
      expect(foreignCursor.status).toBe(400);
      expect(foreignCursor.error?.safe.reasonCode).toBe("CURSOR_INVALID");
    }
  });

  it("customer status history hides staff transition identities and internal notes", async () => {
    const orderId = bOrderId;
    const marker = "Synthetic internal-only transition note";
    const addr = "203.0.113.247";
    const note = `${marker}: ${admin.email}, ${addr}`;
    const { version } = Browser.ok(await b.browser.query<{ version: number }>("orders.get", { orderId }));
    for (const [index, name] of ["Bravo first rename", "Bravo second rename"].entries()) {
      Browser.ok(await admin.browser.mutate("orders.console.rename", { orderId, expectedVersion: version + index, name }));
    }
    Browser.ok(await admin.browser.mutate("orders.transition", {
      orderId, expectedVersion: version + 2, toStatus: "canceled", note, noteVisibility: "internal",
    }, { address: addr }));
    const staff = Browser.ok(await admin.browser.query("orders.admin.get", { orderId }));
    expect(JSON.stringify(staff)).toContain(marker);
    const customer = Browser.ok(await b.browser.query("orders.get", { orderId }));
    expect(customer).toMatchObject({
      statusKey: "canceled", history: expect.arrayContaining([
        expect.objectContaining({ toStatus: "canceled", actorRole: "readypackets", hasNote: false }),
      ]),
    });
    const activity = Browser.ok(await b.browser.query("audit.orderActivity", { orderPublicId: orderId, category: "status" }));
    expect(activity).toMatchObject({
      view: "customer", items: expect.arrayContaining([expect.objectContaining({ label: "Status changed", actor: "ReadyPackets staff" })]),
    });
    const staffHistory = Browser.ok(await admin.browser.query("audit.orderStatusHistory", { orderPublicId: orderId }));
    expect(staffHistory).toMatchObject({
      view: "staff", items: expect.arrayContaining([expect.objectContaining({ kind: "transition", to: "canceled", actor: "Ada Admin", note })]),
    });
    const customerHistory = Browser.ok(await b.browser.query("audit.orderStatusHistory", { orderPublicId: orderId }));
    expect(customerHistory).toMatchObject({
      view: "customer", items: expect.arrayContaining([expect.objectContaining({ kind: "transition", to: "canceled", actor: "ReadyPackets staff", note: null })]),
    });
    for (const privateValue of [marker, "Ada Admin", admin.email, addr, "actorUserId", "sourceAddress"]) {
      expect(JSON.stringify({ customer, activity, customerHistory })).not.toContain(privateValue);
    }
    type TimelineItem = { key: string; at: string; kind: string; newName?: string; to?: string };
    type TimelinePage = { items: TimelineItem[]; nextCursor: string | null };
    const timeline: TimelineItem[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const data: TimelinePage = Browser.ok(await admin.browser.query<TimelinePage>(
        "audit.orderStatusHistory", { orderPublicId: orderId, limit: 1, cursor },
      ));
      expect(data.items).toHaveLength(1);
      timeline.push(...data.items);
      cursor = data.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(new Set(timeline.map(({ key }) => key)).size).toBe(timeline.length);
    const ties = timeline.filter(({ kind, to }) => kind === "rename" || to === "canceled");
    expect(new Set(ties.map(({ at }) => at)).size).toBe(1);
    expect(ties).toEqual([
      expect.objectContaining({ kind: "transition", to: "canceled" }),
      expect.objectContaining({ kind: "rename", newName: "Bravo second rename" }),
      expect.objectContaining({ kind: "rename", newName: "Bravo first rename" }),
    ]);
    Browser.ok(await stepUp(sys, admin.browser, admin.password, admin.secret));
    const { user: { publicId: targetCustomerPublicId } } = Browser.ok(await a.browser.query<{ user: { publicId: string } }>("identity.me"));
    Browser.ok(await admin.browser.mutate("orders.admin.reassign", {
      orderId, expectedVersion: version + 3, targetCustomerPublicId,
      operationId: "synthetic-history-owner-change", reasonCode: "ADMIN_CORRECTION",
    }));
    const newOwner = Browser.ok(await a.browser.query("audit.orderStatusHistory", { orderPublicId: orderId }));
    expect(newOwner).toMatchObject({
      view: "customer", items: expect.arrayContaining([expect.objectContaining({ kind: "rename", actor: "ReadyPackets staff" })]),
    });
    for (const oldName of ["Isolation project bravo", "Bravo first rename"]) {
      expect(JSON.stringify(newOwner)).not.toContain(oldName);
    }
    const formerOwner = await b.browser.query("audit.orderStatusHistory", { orderPublicId: orderId });
    expect(formerOwner.status).toBe(404);
    expect(formerOwner.error?.safe.domainCode).toBe("NOT_FOUND");
  });

  it.todo("B cannot remove or rename A's passkey (needs a virtual WebAuthn authenticator fixture for A)");

  it("every customer-reachable procedure that takes a resource id is probed here", () => {
    const covered = probes();
    const missing = customerProcedures()
      .filter(([path, procedure]) => inputKeys(procedure).some((k) => RESOURCE_KEY.test(k) && !NOT_A_FOREIGN_RESOURCE.has(k)) && !covered[path])
      .map(([path, procedure]) => `${path} (${inputKeys(procedure).join(", ")})`);
    expect(missing).toEqual([]);
  });
});
