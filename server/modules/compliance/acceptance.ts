/**
 * Order policy acceptance gateway (increment 04 part B, package V, ADR 0039). Owner: identity_engineer.
 *
 * A workflow version may attach policies as gates (`order_start` or a named step). While a gate is unmet the
 * acting customer (owner or grantee, each for themselves) may read the order but every customer work mutation
 * is refused by the orders gate port, which calls `provider.assertMet` here (CONFLICT / ORDER_ACCEPTANCE_REQUIRED).
 * Staff and administrators are never gated. Evidence rows are append-only and bound to (order, user, policy
 * version, gate, SHA-256 of the exact text shown) — they can't be replayed for another order or another text.
 */
import { and, count, desc, eq, gte, inArray, lt, lte, or, type SQL } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { getRequestContext } from "../../core/requestContext.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import type { UserRole } from "../../../shared/domain.js";
import { users } from "../identity/schema.js";
import { nameAad } from "../identity/users.js";
import { assertLiveActorInTx } from "./actorAuth.js";
import {
  orderPolicyAcceptances,
  type AcceptanceSignatureMode,
  type OrderPolicyAcceptanceRow,
  type SignatureNameMatchResult,
} from "./acceptanceSchema.js";
import { policyAcceptances, policyDocuments, policyVersions } from "./schema.js";
import {
  loadAccountDisplayName,
  recordSignatureMismatchAuditIfNeeded,
  verifyTypedSignatureInTx,
} from "./signatureNameCheck.js";

/* ------------------------------------------------------------------ ports (orders.gates, agreed with orders_engineer) */

export interface AcceptanceGate {
  key: string;
  policyPublicId: string;
  point: "order_start" | { stepKey: string };
  signatureMode: AcceptanceSignatureMode;
  askAgainOnNewVersion: boolean;
}

export interface OrderGateContext {
  orderId: number;
  orderPublicId: string;
  reference: string;
  name: string;
  customerUserId: number;
  workflowVersionId: number;
  currentStatusKey: string;
  gates: AcceptanceGate[];
  actorAccess: "owner" | "grantee" | "staff" | null;
}

export interface AssertMetInput {
  tx: Tx;
  orderId: number;
  workflowVersionId: number;
  gates: AcceptanceGate[];
  actor: { userId: number; role: UserRole };
  point: { kind: "order_start" } | { kind: "step"; stepKey: string };
}

interface OrderGatesPort {
  context(orderPublicId: string, actor: SessionPrincipal, tx?: Tx): Promise<OrderGateContext | null>;
  registerProvider(
    key: "acceptance",
    provider: {
      assertMet(input: AssertMetInput): Promise<void>;
      agreementStatus?(input: { tx: DbOrTx; userId: number; gate: AcceptanceGate }): Promise<{ met: boolean }>;
    },
  ): void;
}

/* ------------------------------------------------------------------ helpers */

const MAX_LIMIT = 100;
const GATE_AUDIENCES = ["customer", "all"] as const;
const typedNameAad = (publicId: string) => `order_policy_acceptances.typed_name:${publicId}`;
const sourceAddressAad = (publicId: string) => `order_policy_acceptances.ip:${publicId}`;
const isStaffRole = (role: UserRole | string) => role === "staff" || role === "admin";

export const ACCEPTANCE_REQUIRED_MESSAGE = "Please review and accept the policy for this order before continuing.";

function acceptanceRequired(): DomainError {
  return conflict("ORDER_ACCEPTANCE_REQUIRED", ACCEPTANCE_REQUIRED_MESSAGE);
}

/** NFC, trimmed, inner whitespace collapsed, 2–120 code points, no control characters. */
export function normalizeTypedName(raw: string): string | null {
  const value = raw.normalize("NFC").replace(/\s+/gu, " ").trim();
  const length = [...value].length;
  if (length < 2 || length > 120) return null;
  if (/[\p{Cc}\p{Cf}]/u.test(value)) return null;
  if (!/\p{L}/u.test(value)) return null;
  return value;
}

/** Gates that apply to a point: order_start gates always; step gates when the step matches. */
export function gatesForPoint(gates: readonly AcceptanceGate[], point: AssertMetInput["point"]): AcceptanceGate[] {
  return gates.filter((gate) => gate.point === "order_start" || (point.kind === "step" && gate.point.stepKey === point.stepKey));
}

function encodeCursor(id: number): string {
  return Buffer.from(`a1:${id}`, "utf8").toString("base64url");
}
function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  const match = /^[A-Za-z0-9_-]{1,40}$/.test(cursor) ? /^a1:(\d{1,15})$/.exec(Buffer.from(cursor, "base64url").toString("utf8")) : null;
  if (!match) throw validation("INVALID_CURSOR", "The list position is not valid. Reload the list.");
  return Number(match[1]);
}

type PolicyCurrent = {
  documentId: number;
  documentPublicId: string;
  title: string;
  versionId: number;
  versionPublicId: string;
  versionNumber: number;
  versionLabel: string;
  contentFormat: "plain_text" | "safe_markdown";
  bodyText: string;
  contentHash: string;
};

/* ------------------------------------------------------------------ service */

export function createAcceptanceService(deps: ModuleDeps) {
  function gatesPort(): OrderGatesPort {
    const port = (deps.services as unknown as { orders?: { gates?: OrderGatesPort } }).orders?.gates;
    if (!port) throw new DomainError("UNAVAILABLE", "ORDER_GATES_UNAVAILABLE", "This order can't be opened right now. Please try again later.");
    return port;
  }

  /** Current published, effective, portal version of active policies, keyed by document public id. */
  async function currentPolicies(dbOrTx: DbOrTx, documentPublicIds: readonly string[], opts: { lockShared?: boolean } = {}): Promise<Map<string, PolicyCurrent>> {
    const out = new Map<string, PolicyCurrent>();
    const ids = [...new Set(documentPublicIds)];
    if (ids.length === 0) return out;
    // Customer-facing gates only: staff-only (or since-deactivated) policies never surface and can't be met (fail closed).
    const query = dbOrTx
      .select()
      .from(policyDocuments)
      .where(and(inArray(policyDocuments.publicId, ids), eq(policyDocuments.active, true), inArray(policyDocuments.audience, [...GATE_AUDIENCES])));
    // In accept(): shared lock on the document rows serializes with publication (which updates the document row).
    const docs = opts.lockShared ? await query.for("share") : await query;
    if (docs.length === 0) return out;
    const versions = await dbOrTx
      .select()
      .from(policyVersions)
      .where(
        and(
          inArray(policyVersions.documentId, docs.map((d) => d.id)),
          eq(policyVersions.status, "published"),
          eq(policyVersions.origin, "portal"),
          lte(policyVersions.effectiveAt, deps.clock.now()),
        ),
      )
      .orderBy(desc(policyVersions.versionNumber), desc(policyVersions.id));
    for (const doc of docs) {
      const ver = versions.find((v) => v.documentId === doc.id);
      if (!ver) continue;
      out.set(doc.publicId, {
        documentId: doc.id, documentPublicId: doc.publicId, title: doc.title,
        versionId: ver.id, versionPublicId: ver.publicId, versionNumber: ver.versionNumber, versionLabel: ver.versionLabel,
        contentFormat: ver.contentFormat, bodyText: ver.bodyText, contentHash: ver.contentHash,
      });
    }
    return out;
  }

  async function acceptancesOf(dbOrTx: DbOrTx, orderId: number, userId: number): Promise<OrderPolicyAcceptanceRow[]> {
    return dbOrTx
      .select()
      .from(orderPolicyAcceptances)
      .where(and(eq(orderPolicyAcceptances.orderId, orderId), eq(orderPolicyAcceptances.userId, userId)))
      .orderBy(desc(orderPolicyAcceptances.id));
  }

  /**
   * Met when the user has a row for this order + gate on the same policy document; with "ask again" only a
   * row on the CURRENT version counts. A gate whose policy has no published version can't be met (fail closed).
   */
  function gateMet(gate: AcceptanceGate, policy: PolicyCurrent | undefined, rows: readonly OrderPolicyAcceptanceRow[], workflowVersionId: number): OrderPolicyAcceptanceRow | null {
    if (!policy) return null;
    // Evidence must match this gate as configured on the order's pinned workflow version: same gate key, policy,
    // workflow version and signature mode (a re-pinned order or a gate switched to typed signature asks again).
    const mine = rows.filter(
      (r) => r.gateKey === gate.key && r.policyDocumentId === policy.documentId && r.workflowVersionId === workflowVersionId && r.signatureMode === gate.signatureMode,
    );
    if (gate.askAgainOnNewVersion) return mine.find((r) => r.policyVersionId === policy.versionId && r.textSha256 === policy.contentHash) ?? null;
    return mine[0] ?? null;
  }

  async function userNames(dbOrTx: DbOrTx, ids: readonly number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const unique = [...new Set(ids)];
    if (unique.length === 0) return out;
    const rows = await dbOrTx.select({ id: users.id, publicId: users.publicId, nameEnc: users.nameEnc }).from(users).where(inArray(users.id, unique));
    for (const row of rows) out.set(row.id, deps.crypto.decrypt(row.nameEnc, nameAad(row.publicId)));
    return out;
  }

  async function contextOrNotFound(orderPublicId: string, principal: SessionPrincipal, tx?: Tx): Promise<OrderGateContext> {
    const ctx = await gatesPort().context(orderPublicId, principal, tx);
    if (!ctx || ctx.actorAccess === null) throw notFound("ORDER_NOT_FOUND");
    return ctx;
  }

  function receiptView(row: OrderPolicyAcceptanceRow, extra: { orderReference: string; orderName: string; policyTitle: string; versionLabel: string; signerName: string }) {
    return {
      receiptId: row.publicId,
      order: { id: row.orderPublicId, reference: extra.orderReference, name: extra.orderName },
      policy: { id: row.policyPublicId, title: extra.policyTitle, versionNumber: row.policyVersionNumber, versionLabel: extra.versionLabel },
      gateKey: row.gateKey,
      textSha256: row.textSha256,
      signatureMode: row.signatureMode,
      typedName: row.typedNameEnc ? deps.crypto.decrypt(row.typedNameEnc, typedNameAad(row.publicId)) : null,
      typedNameMatch: row.typedNameMatch ?? null,
      signerName: extra.signerName,
      acceptedAt: row.acceptedAt.toISOString(),
    };
  }

  /**
   * Version label + document title for receipts. The title is read from the CURRENT document row, so for a
   * customer reader it is withheld ("Policy") once the document is inactive or no longer customer-visible —
   * otherwise a rename + reclassification to staff-only would leak through an old receipt. Staff see it.
   */
  async function versionLabels(dbOrTx: DbOrTx, versionIds: readonly number[], customerReader = false) {
    const out = new Map<number, { label: string; title: string }>();
    const unique = [...new Set(versionIds)];
    if (unique.length === 0) return out;
    const rows = await dbOrTx
      .select({ id: policyVersions.id, label: policyVersions.versionLabel, title: policyDocuments.title, active: policyDocuments.active, audience: policyDocuments.audience })
      .from(policyVersions)
      .innerJoin(policyDocuments, eq(policyDocuments.id, policyVersions.documentId))
      .where(inArray(policyVersions.id, unique));
    for (const r of rows) {
      const visible = r.active && (GATE_AUDIENCES as readonly string[]).includes(r.audience);
      out.set(r.id, { label: r.label, title: customerReader && !visible ? "Policy" : r.title });
    }
    return out;
  }

  async function countRows(orderId: number): Promise<number> {
    const [row] = await deps.db.select({ n: count() }).from(orderPolicyAcceptances).where(eq(orderPolicyAcceptances.orderId, orderId));
    return Number(row?.n ?? 0);
  }

  /* -------------------------------------------------------------- gate provider (called by orders.gates) */

  const provider = {
    async assertMet(input: AssertMetInput): Promise<void> {
      if (isStaffRole(input.actor.role)) return;
      const applicable = gatesForPoint(input.gates, input.point);
      if (applicable.length === 0) return;
      const policies = await currentPolicies(input.tx, applicable.map((g) => g.policyPublicId));
      const rows = await acceptancesOf(input.tx, input.orderId, input.actor.userId);
      for (const gate of applicable) {
        if (!gateMet(gate, policies.get(gate.policyPublicId), rows, input.workflowVersionId)) throw acceptanceRequired();
      }
    },

    /**
     * Increment 06 D14: Read-only account-level agreement check for `orders.agreement_gate`.
     * Met when the acting user has a portal acceptance of the gate's active customer/all published policy
     * (current published version when `gate.askAgainOnNewVersion`, otherwise any portal-accepted version).
     */
    async agreementStatus(input: { tx: DbOrTx; userId: number; gate: AcceptanceGate }): Promise<{ met: boolean }> {
      const policy = (await currentPolicies(input.tx, [input.gate.policyPublicId])).get(input.gate.policyPublicId);
      if (!policy) return { met: false };

      if (input.gate.askAgainOnNewVersion) {
        const [row] = await input.tx
          .select({ id: policyAcceptances.id })
          .from(policyAcceptances)
          .where(
            and(
              eq(policyAcceptances.userId, input.userId),
              eq(policyAcceptances.policyVersionId, policy.versionId),
              eq(policyAcceptances.versionContentHash, policy.contentHash),
              eq(policyAcceptances.origin, "portal"),
            ),
          )
          .limit(1);
        return { met: row !== undefined };
      }

      const [row] = await input.tx
        .select({ id: policyAcceptances.id })
        .from(policyAcceptances)
        .where(
          and(
            eq(policyAcceptances.userId, input.userId),
            eq(policyAcceptances.documentId, policy.documentId),
            eq(policyAcceptances.origin, "portal"),
          ),
        )
        .limit(1);
      return { met: row !== undefined };
    },
  };

  return {
    provider,

    /** Registers the provider on the orders gate port (call from the compliance module's init()). */
    register(): void {
      const port = (deps.services as unknown as { orders?: { gates?: OrderGatesPort } }).orders?.gates;
      port?.registerProvider("acceptance", provider);
    },

    /** Customer and console: the order's gates, their text and whether the CALLER has met them. */
    async forOrder(principal: SessionPrincipal, input: { orderId: string }) {
      const ctx = await contextOrNotFound(input.orderId, principal);
      const policies = await currentPolicies(deps.db, ctx.gates.map((g) => g.policyPublicId));
      const staff = isStaffRole(principal.role);
      const [rows, expectedSignerName] = await Promise.all([
        staff ? Promise.resolve([]) : acceptancesOf(deps.db, ctx.orderId, principal.userId),
        staff ? Promise.resolve(null) : loadAccountDisplayName(deps, principal.userId, deps.db),
      ]);
      const gates = ctx.gates.map((gate) => {
        const policy = policies.get(gate.policyPublicId);
        const met = gateMet(gate, policy, rows, ctx.workflowVersionId);
        const applies = gate.point === "order_start" || gate.point.stepKey === ctx.currentStatusKey;
        return {
          key: gate.key,
          point: gate.point === "order_start" ? ({ kind: "order_start" } as const) : ({ kind: "step", stepKey: gate.point.stepKey } as const),
          signatureMode: gate.signatureMode,
          askAgainOnNewVersion: gate.askAgainOnNewVersion,
          applies,
          required: !staff,
          met: staff ? true : met !== null,
          acceptance: met ? { receiptId: met.publicId, acceptedAt: met.acceptedAt.toISOString(), versionNumber: met.policyVersionNumber } : null,
          policy: policy
            ? { id: policy.documentPublicId, title: policy.title, versionId: policy.versionPublicId, versionNumber: policy.versionNumber, versionLabel: policy.versionLabel, contentFormat: policy.contentFormat, text: policy.bodyText, textSha256: policy.contentHash }
            : null,
        };
      });
      return { orderId: ctx.orderPublicId, expectedSignerName, blocking: gates.some((g) => g.required && g.applies && !g.met), gates };
    },

    /** Customer (owner or grantee) records their own acceptance. Idempotent per (order, user, version, gate). */
    async accept(principal: SessionPrincipal, input: { orderId: string; gateKey: string; policyVersionId: string; textSha256: string; typedName?: string | undefined }) {
      if (isStaffRole(principal.role)) throw forbidden("STAFF_NOT_GATED");
      const request = getRequestContext();
      const resource = { type: "order", publicId: input.orderId };
      try {
        return await deps.db.transaction(async (tx) => {
          const actor = await assertLiveActorInTx(deps, principal, tx);
          if (isStaffRole(actor.role)) throw forbidden("STAFF_NOT_GATED");
          const ctx = await contextOrNotFound(input.orderId, principal, tx);
          if (ctx.actorAccess === "staff") throw forbidden("STAFF_NOT_GATED");
          const gate = ctx.gates.find((g) => g.key === input.gateKey);
          if (!gate) throw notFound("GATE_NOT_FOUND");
          const policy = (await currentPolicies(tx, [gate.policyPublicId], { lockShared: true })).get(gate.policyPublicId);
          if (!policy) throw conflict("POLICY_UNAVAILABLE", "This policy isn't available right now. Please contact support.");
          if (input.policyVersionId !== policy.versionPublicId || input.textSha256 !== policy.contentHash) {
            throw conflict("POLICY_TEXT_CHANGED", "The policy was updated. Please read the current text and accept again.");
          }
          let typedName: string | null = null;
          let typedNameMatch: SignatureNameMatchResult | null = null;
          if (gate.signatureMode === "typed_name") {
            const candidate = input.typedName === undefined ? null : normalizeTypedName(input.typedName);
            if (!candidate) throw validation("TYPED_NAME_REQUIRED", "Type your full name to sign.", { field: "typedName" });
            const verified = await verifyTypedSignatureInTx(deps, {
              tx,
              userId: actor.userId,
              actorRole: actor.role,
              typedName: candidate,
              requiredErrorCode: "TYPED_NAME_REQUIRED",
              requiredErrorMessage: "Type your full name to sign.",
              requiredField: "typedName",
              resource: { type: "order", publicId: ctx.orderPublicId },
            });
            typedName = verified.cleanedTypedName;
            typedNameMatch = verified.matchResult;
          }

          const [existing] = await tx
            .select()
            .from(orderPolicyAcceptances)
            .where(and(
              eq(orderPolicyAcceptances.orderId, ctx.orderId), eq(orderPolicyAcceptances.userId, actor.userId),
              eq(orderPolicyAcceptances.policyVersionId, policy.versionId), eq(orderPolicyAcceptances.gateKey, gate.key),
              eq(orderPolicyAcceptances.workflowVersionId, ctx.workflowVersionId),
            ))
            .limit(1);
          let row = existing;
          let duplicate = true;
          if (!row) {
            duplicate = false;
            const publicId = ulid();
            const now = deps.clock.now();
            const ip = request?.ipAddress ?? null;
            const userAgent = request?.userAgent ? request.userAgent.replace(/[\p{Cc}]/gu, "").slice(0, 512) : null;
            await tx.insert(orderPolicyAcceptances).values({
              publicId, orderId: ctx.orderId, orderPublicId: ctx.orderPublicId, userId: actor.userId, gateKey: gate.key,
              workflowVersionId: ctx.workflowVersionId, policyDocumentId: policy.documentId, policyVersionId: policy.versionId,
              policyPublicId: policy.documentPublicId, policyVersionNumber: policy.versionNumber, textSha256: policy.contentHash,
              signatureMode: gate.signatureMode, typedNameEnc: typedName ? deps.crypto.encrypt(typedName, typedNameAad(publicId)) : null,
              typedNameMatch,
              acceptedAt: now, sourceAddressEnc: ip ? deps.crypto.encrypt(ip, sourceAddressAad(publicId)) : null,
              userAgent, requestId: request?.requestId ?? ulid(), createdAt: now,
            });
            [row] = await tx.select().from(orderPolicyAcceptances).where(eq(orderPolicyAcceptances.publicId, publicId)).limit(1);
            await deps.audit.record(
              {
                category: "business",
                eventName: "order.acceptance.recorded",
                action: "accept",
                outcome: "completed",
                actor: { userId: actor.userId, role: actor.role },
                resource: { type: "order", publicId: ctx.orderPublicId },
                attributes: {
                  acceptance_public_id: publicId, gate_key: gate.key, policy_public_id: policy.documentPublicId,
                  policy_version: policy.versionNumber, text_sha256: policy.contentHash, signature_mode: gate.signatureMode,
                  ...(typedNameMatch ? { signature_match: typedNameMatch } : {}),
                  access: ctx.actorAccess ?? "none",
                },
              },
              tx,
            );
          }
          const names = await userNames(tx, [actor.userId]);
          return {
            duplicate,
            receipt: receiptView(row!, { orderReference: ctx.reference, orderName: ctx.name, policyTitle: policy.title, versionLabel: policy.versionLabel, signerName: names.get(actor.userId) ?? "" }),
          };
        });
      } catch (err) {
        if (err instanceof DomainError) {
          await recordSignatureMismatchAuditIfNeeded(
            deps,
            { userId: principal.userId, role: principal.role },
            resource,
            err,
          );
        }
        throw err;
      }
    },

    /** Printable receipt: the signer themselves, or staff/admin who can read the order. */
    async receipt(principal: SessionPrincipal, input: { receiptId: string }) {
      const [row] = await deps.db.select().from(orderPolicyAcceptances).where(eq(orderPolicyAcceptances.publicId, input.receiptId)).limit(1);
      if (!row) throw notFound("RECEIPT_NOT_FOUND");
      const staff = isStaffRole(principal.role);
      if (!staff && row.userId !== principal.userId) throw notFound("RECEIPT_NOT_FOUND");
      const ctx = await gatesPort().context(row.orderPublicId, principal);
      if (!ctx || ctx.actorAccess === null) throw notFound("RECEIPT_NOT_FOUND");
      const labels = await versionLabels(deps.db, [row.policyVersionId], !staff);
      const names = await userNames(deps.db, [row.userId]);
      const label = labels.get(row.policyVersionId);
      return receiptView(row, { orderReference: ctx.reference, orderName: ctx.name, policyTitle: label?.title ?? "Policy", versionLabel: label?.label ?? String(row.policyVersionNumber), signerName: names.get(row.userId) ?? "" });
    },

    /** Console tab label count (one indexed COUNT). Staff/admin with order access only. */
    async consoleCount(principal: SessionPrincipal, input: { orderId: string }) {
      if (!isStaffRole(principal.role)) throw forbidden("CONSOLE_ONLY");
      const ctx = await contextOrNotFound(input.orderId, principal);
      return { total: await countRows(ctx.orderId) };
    },

    /** Console "Acceptances (n)": staff/admin with order access. Source address only with sessions.read_all. */
    async consoleList(principal: SessionPrincipal, input: { orderId: string; cursor?: string | undefined; limit?: number | undefined }) {
      if (!isStaffRole(principal.role)) throw forbidden("CONSOLE_ONLY");
      const ctx = await contextOrNotFound(input.orderId, principal);
      const limit = Math.min(Math.max(input.limit ?? 25, 1), MAX_LIMIT);
      const after = decodeCursor(input.cursor);
      const conditions = [eq(orderPolicyAcceptances.orderId, ctx.orderId)];
      if (after !== null) conditions.push(lt(orderPolicyAcceptances.id, after));
      const rows = await deps.db.select().from(orderPolicyAcceptances).where(and(...conditions)).orderBy(desc(orderPolicyAcceptances.id)).limit(limit + 1);
      const page = rows.slice(0, limit);
      const [names, labels] = await Promise.all([userNames(deps.db, page.map((r) => r.userId)), versionLabels(deps.db, page.map((r) => r.policyVersionId))]);
      const showAddress = roleHasCapability(principal.role, "sessions.read_all");
      const total = await countRows(ctx.orderId);
      const items = page.map((row) => {
        const label = labels.get(row.policyVersionId);
        return {
          ...receiptView(row, { orderReference: ctx.reference, orderName: ctx.name, policyTitle: label?.title ?? "", versionLabel: label?.label ?? String(row.policyVersionNumber), signerName: names.get(row.userId) ?? "" }),
          signerRole: row.userId === ctx.customerUserId ? ("owner" as const) : ("grantee" as const),
          userAgent: row.userAgent,
          sourceAddress: showAddress && row.sourceAddressEnc ? deps.crypto.decrypt(row.sourceAddressEnc, sourceAddressAad(row.publicId)) : null,
        };
      });
      if (showAddress && items.some((i) => i.sourceAddress)) {
        await deps.audit.record({
          category: "security", eventName: "order.acceptance.addresses_viewed", action: "read", outcome: "completed",
          resource: { type: "order", publicId: ctx.orderPublicId }, safeCounts: { results: items.length },
        });
      }
      return { total, items, nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!.id) : null };
    },

    /**
     * Internal read port for the policy acceptance log centre (Increment 05 D4; caller: compliance log service,
     * which authorizes `policies.acceptances.read` first and audits). Not on tRPC. Newest first by
     * (acceptedAt DESC, publicId DESC) — the same keyset as `policy_acceptances`, so the caller can merge both
     * streams with one `before` cursor. The raw source address never leaves: it is returned as the same HMAC
     * pseudonym `policy_acceptances` stores. Typed names stay encrypted (AAD returned for the detail dialog).
     */
    async evidencePage(filter: EvidenceFilter, opts: { tx?: DbOrTx } = {}): Promise<{ items: OrderGateEvidence[]; hasMore: boolean }> {
      const limit = Math.min(Math.max(Math.trunc(filter.limit), 1), EVIDENCE_MAX_LIMIT);
      const lists = [filter.userIds, filter.policyDocumentIds, filter.policyVersionIds, filter.orderIds];
      if (lists.some((l) => l !== undefined && l.length > EVIDENCE_MAX_IDS)) throw validation("FILTER_TOO_LARGE", "Too many filter values.");
      // An explicitly empty id list means "matches nothing" (e.g. a customer search that found no one).
      if (lists.some((l) => l !== undefined && l.length === 0)) return { items: [], hasMore: false };
      const t = orderPolicyAcceptances;
      const conditions: (SQL | undefined)[] = [
        filter.userIds ? inArray(t.userId, [...filter.userIds]) : undefined,
        filter.policyDocumentIds ? inArray(t.policyDocumentId, [...filter.policyDocumentIds]) : undefined,
        filter.policyVersionIds ? inArray(t.policyVersionId, [...filter.policyVersionIds]) : undefined,
        filter.orderIds ? inArray(t.orderId, [...filter.orderIds]) : undefined,
        filter.method ? eq(t.signatureMode, filter.method) : undefined,
        filter.from ? gte(t.acceptedAt, filter.from) : undefined,
        filter.to ? lt(t.acceptedAt, filter.to) : undefined,
        filter.before
          ? or(lt(t.acceptedAt, filter.before.acceptedAt), and(eq(t.acceptedAt, filter.before.acceptedAt), lt(t.publicId, filter.before.publicId)))
          : undefined,
      ];
      const rows = await (opts.tx ?? deps.db)
        .select({
          publicId: t.publicId, acceptedAt: t.acceptedAt, userId: t.userId, policyDocumentId: t.policyDocumentId, policyPublicId: t.policyPublicId,
          policyVersionId: t.policyVersionId, policyVersionNumber: t.policyVersionNumber, textSha256: t.textSha256, method: t.signatureMode,
          orderId: t.orderId, orderPublicId: t.orderPublicId, gateKey: t.gateKey, workflowVersionId: t.workflowVersionId,
          sourceAddressEnc: t.sourceAddressEnc, requestId: t.requestId, typedNameEnc: t.typedNameEnc, typedNameMatch: t.typedNameMatch,
        })
        .from(t)
        .where(and(...conditions))
        .orderBy(desc(t.acceptedAt), desc(t.publicId))
        .limit(limit + 1);
      const items = rows.slice(0, limit).map(({ sourceAddressEnc, requestId, typedNameEnc, typedNameMatch, ...row }): OrderGateEvidence => ({
        ...row,
        addressPseudonym: sourceAddressEnc
          ? deps.crypto.pseudonym(deps.crypto.decrypt(sourceAddressEnc, sourceAddressAad(row.publicId)), ADDRESS_PSEUDONYM_PURPOSE)
          : null,
        correlationId: requestId,
        signerNameEnc: typedNameEnc,
        signerNameAad: typedNameEnc ? typedNameAad(row.publicId) : null,
        typedNameMatch: typedNameMatch ?? null,
      }));
      return { items, hasMore: rows.length > limit };
    },

    /**
     * Coverage / policy-updates helper: distinct user ids with order gate evidence per policy version, in one
     * grouped query (no paging). Same caller rules as `evidencePage`.
     */
    async acceptorsByVersion(policyVersionIds: readonly number[], opts: { userIds?: readonly number[]; tx?: DbOrTx } = {}): Promise<Map<number, number[]>> {
      const out = new Map<number, number[]>();
      const versions = [...new Set(policyVersionIds)];
      if (versions.length === 0 || opts.userIds?.length === 0) return out;
      if (versions.length > EVIDENCE_MAX_IDS || (opts.userIds && opts.userIds.length > EVIDENCE_MAX_IDS)) throw validation("FILTER_TOO_LARGE", "Too many filter values.");
      const t = orderPolicyAcceptances;
      const rows = await (opts.tx ?? deps.db)
        .selectDistinct({ versionId: t.policyVersionId, userId: t.userId })
        .from(t)
        .where(and(inArray(t.policyVersionId, versions), opts.userIds ? inArray(t.userId, [...opts.userIds]) : undefined));
      for (const r of rows) out.set(r.versionId, [...(out.get(r.versionId) ?? []), r.userId]);
      return out;
    },
  };
}

export const EVIDENCE_MAX_LIMIT = 200;
export const EVIDENCE_MAX_IDS = 500;
/** Same purpose string as `policy_acceptances.source_address_pseudonym`, so one address correlates across both. */
export const ADDRESS_PSEUDONYM_PURPOSE = "compliance.policy_acceptance.ip";

export interface EvidenceFilter {
  userIds?: readonly number[] | undefined;
  policyDocumentIds?: readonly number[] | undefined;
  policyVersionIds?: readonly number[] | undefined;
  orderIds?: readonly number[] | undefined;
  method?: AcceptanceSignatureMode | undefined;
  /** Inclusive. */
  from?: Date | undefined;
  /** Exclusive. */
  to?: Date | undefined;
  /** Keyset cursor: rows strictly older than this (acceptedAt, publicId). */
  before?: { acceptedAt: Date; publicId: string } | undefined;
  /** 1..200. */
  limit: number;
}

export interface OrderGateEvidence {
  publicId: string;
  acceptedAt: Date;
  userId: number;
  policyDocumentId: number;
  policyPublicId: string;
  policyVersionId: number;
  policyVersionNumber: number;
  textSha256: string;
  method: AcceptanceSignatureMode;
  orderId: number;
  orderPublicId: string;
  gateKey: string;
  workflowVersionId: number;
  addressPseudonym: string | null;
  correlationId: string;
  signerNameEnc: string | null;
  signerNameAad: string | null;
  typedNameMatch?: SignatureNameMatchResult | null;
}

export type AcceptanceService = ReturnType<typeof createAcceptanceService>;
