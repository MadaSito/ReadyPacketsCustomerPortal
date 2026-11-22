/**
 * Policy Acceptance Log Centre — server service (Increment 05 Package D1 / Decision D4).
 *
 * Unifies immutable acceptance evidence across:
 *   1. `policy_acceptances` (account-level, registration, portal acceptance/re-acceptance, checkout, imported historical)
 *   2. `order_policy_acceptances` (per-order workflow gate acceptances via `compliance.acceptance.evidencePage` & `acceptorsByVersion`)
 *
 * Security & privacy invariants:
 *   - Append-only read surface: NO evidence row is ever mutated or deleted.
 *   - Authorization (§4):
 *       * `customer` role receives `NOT_FOUND` on every admin procedure (no existence/surface oracle).
 *       * `staff` without the required capability receives `FORBIDDEN`.
 *       * `export` requires `policies.acceptances.export` + fresh step-up re-validated live inside `tx`,
 *         and records `policy.acceptance_log.exported` transactionally.
 *   - Typed signer name privacy:
 *       * `list`, `forCustomer`, and `export` NEVER include `typedSignerName` (property absent from DTOs and CSV).
 *       * `detail` decrypts `signerNameEnc` ONLY when the live actor is active and holds `policies.manage`;
 *         otherwise `typedSignerName: null` and `signerNameRedacted: hasTypedSignature`.
 */
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lt,
  notInArray,
  or,
  type SQL,
} from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { hasFreshStepUp } from "../../trpc/trpc.js";
import { users, type UserStatus } from "../identity/schema.js";
import type { UserView } from "../identity/index.js";
import { orders } from "../orders/schema.js";
import { EVIDENCE_MAX_IDS, EVIDENCE_MAX_LIMIT, type OrderGateEvidence } from "./acceptance.js";
import { orderPolicyAcceptances } from "./acceptanceSchema.js";
import { assertLiveActorInTx, runComplianceTx } from "./actorAuth.js";
import {
  policyAcceptances,
  policyDocuments,
  policyVersions,
  type PolicyAcceptanceContext,
  type PolicyAcceptanceMethod,
  type PolicyAudience,
  type PolicyContentFormat,
} from "./schema.js";

type PolicyDocumentRow = typeof policyDocuments.$inferSelect;
type PolicyVersionRow = typeof policyVersions.$inferSelect;

/* ------------------------------------------------------------------ public DTOs */

export const ACCEPTANCE_LOG_SOURCES = [
  "registration",
  "portal_acceptance",
  "portal_reacceptance",
  "checkout",
  "order_gate",
  "imported_historical",
] as const;
export type AcceptanceLogSource = (typeof ACCEPTANCE_LOG_SOURCES)[number];

export const ACCEPTANCE_LOG_METHODS = ["checkbox", "typed_signature", "imported"] as const;
export type AcceptanceLogMethod = (typeof ACCEPTANCE_LOG_METHODS)[number];

export const ACCEPTANCE_FRESHNESS_VALUES = ["current", "superseded"] as const;
export type AcceptanceFreshness = (typeof ACCEPTANCE_FRESHNESS_VALUES)[number];

export type AcceptanceEvidenceKind = "account" | "order_gate";

export interface AcceptanceLogCustomerSummary {
  userPublicId: string;
  name: string;
  email: string;
  customerRef: string | null;
}

export interface AcceptanceLogFilterInput {
  customerQuery?: string | undefined;
  customerPublicId?: string | undefined;
  policyDocumentPublicId?: string | undefined;
  versionPublicId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  source?: AcceptanceLogSource | undefined;
  method?: AcceptanceLogMethod | undefined;
  freshness?: AcceptanceFreshness | undefined;
  orderReference?: string | undefined;
}

export interface AcceptanceLogListInput extends AcceptanceLogFilterInput {
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface AcceptanceLogItem {
  publicId: string;
  evidenceKind: AcceptanceEvidenceKind;
  acceptedAt: Date;
  customer: AcceptanceLogCustomerSummary | null;
  policyDocumentPublicId: string;
  policySlug: string;
  policyTitle: string;
  versionPublicId: string;
  versionNumber: number;
  versionLabel: string;
  contentHash: string;
  shortContentHash: string;
  source: AcceptanceLogSource;
  method: AcceptanceLogMethod;
  hasTypedSignature: boolean;
  freshness: AcceptanceFreshness;
  supersededByVersionPublicId: string | null;
  supersededByVersionLabel: string | null;
  orderPublicId: string | null;
  orderReference: string | null;
  gateKey: string | null;
  addressPseudonym: string | null;
  correlationId: string | null;
  origin: "portal" | "import";
}

export interface AcceptanceLogDetailView extends AcceptanceLogItem {
  contentFormat: PolicyContentFormat;
  bodyText: string;
  effectiveAt: Date;
  publishedAt: Date | null;
  typedSignerName: string | null;
  signerNameRedacted: boolean;
}

export interface AcceptanceFilterOptionsView {
  policies: Array<{
    documentPublicId: string;
    slug: string;
    title: string;
    audience: PolicyAudience;
    active: boolean;
    requiresAcceptance: boolean;
    versions: Array<{
      versionPublicId: string;
      versionNumber: number;
      versionLabel: string;
      publishedAt: Date | null;
      isCurrent: boolean;
    }>;
  }>;
}

export interface PolicyCoverageOutstandingCustomer {
  customer: AcceptanceLogCustomerSummary;
  lastAcceptedVersionPublicId: string | null;
  lastAcceptedVersionNumber: number | null;
  lastAcceptedVersionLabel: string | null;
  lastAcceptedAt: Date | null;
}

export interface PolicyCoverageDocumentView {
  documentPublicId: string;
  slug: string;
  title: string;
  audience: PolicyAudience;
  currentVersionPublicId: string;
  currentVersionNumber: number;
  currentVersionLabel: string;
  publishedAt: Date | null;
  effectiveAt: Date;
  activeCustomerCount: number;
  acceptedCurrentCount: number;
  outstandingCount: number;
  outstandingCustomers: PolicyCoverageOutstandingCustomer[];
  outstandingTruncated: boolean;
}

export interface PolicyCoverageView {
  activeCustomerCount: number;
  policies: PolicyCoverageDocumentView[];
}

export interface PolicyUpdateHistoryItem {
  documentPublicId: string;
  policySlug: string;
  policyTitle: string;
  audience: PolicyAudience;
  versionPublicId: string;
  versionNumber: number;
  versionLabel: string;
  contentHash: string;
  shortContentHash: string;
  changeSummary: string | null;
  publishedAt: Date | null;
  effectiveAt: Date;
  publishedBy: { userPublicId: string; name: string; email: string } | null;
  isCurrent: boolean;
  acceptedCustomerCount: number;
}

export type CustomerPolicyRequirementState =
  | "accepted_current"
  | "update_pending"
  | "not_accepted"
  | "not_required";

export interface CustomerPolicyStatusRow {
  documentPublicId: string;
  slug: string;
  title: string;
  requiresAcceptance: boolean;
  requiresTypedSignature: boolean;
  currentVersionPublicId: string;
  currentVersionNumber: number;
  currentVersionLabel: string;
  currentPublishedAt: Date | null;
  currentEffectiveAt: Date;
  state: CustomerPolicyRequirementState;
  acceptedVersionPublicId: string | null;
  acceptedVersionNumber: number | null;
  acceptedVersionLabel: string | null;
  acceptedAt: Date | null;
}

export interface CustomerPolicyAcceptanceProfileView {
  customer: AcceptanceLogCustomerSummary;
  policies: CustomerPolicyStatusRow[];
  history: AcceptanceLogItem[];
  nextCursor: string | null;
}

export interface PolicyVersionReadView {
  documentPublicId: string;
  policySlug: string;
  policyTitle: string;
  audience: PolicyAudience;
  requiresAcceptance: boolean;
  requiresTypedSignature: boolean;
  versionPublicId: string;
  versionNumber: number;
  versionLabel: string;
  contentFormat: PolicyContentFormat;
  bodyText: string;
  contentHash: string;
  shortContentHash: string;
  changeSummary: string | null;
  effectiveAt: Date;
  publishedAt: Date | null;
  isCurrent: boolean;
}

export interface AcceptanceLogExportResult {
  filename: string;
  contentType: "text/csv; charset=utf-8";
  csv: string;
  rowCount: number;
  truncated: boolean;
  maxRows: number;
}

/* ------------------------------------------------------------------ constants & pure helpers */

export const MAX_ACCEPTANCE_EXPORT_ROWS = 5_000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const DEFAULT_FOR_CUSTOMER_LIMIT = 25;
const DEFAULT_OUTSTANDING_LIMIT = 100;
const MAX_OUTSTANDING_LIMIT = 250;
const LEGACY_REGISTRATION_WINDOW_MS = 120_000;

export const ACCEPTANCE_CSV_COLUMNS = [
  "evidence_public_id",
  "accepted_at_utc",
  "customer_public_id",
  "customer_reference",
  "customer_name",
  "customer_email",
  "policy_slug",
  "policy_title",
  "version_number",
  "version_label",
  "content_sha256",
  "freshness",
  "source",
  "method",
  "order_reference",
  "correlation_id",
] as const;

const signerNameAad = (acceptancePublicId: string) =>
  `policy_acceptances.signer_name:${acceptancePublicId}`;

interface KeysetCursor {
  acceptedAt: Date;
  publicId: string;
}

export function encodeAcceptanceLogCursor(cursor: KeysetCursor): string {
  return Buffer.from(
    JSON.stringify({ a: cursor.acceptedAt.getTime(), p: cursor.publicId }),
    "utf8",
  ).toString("base64url");
}

export function decodeAcceptanceLogCursor(raw: string | undefined): KeysetCursor | undefined {
  if (!raw) return undefined;
  if (raw.length > 128 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw validation("INVALID_CURSOR", "Pagination cursor is not valid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw validation("INVALID_CURSOR", "Pagination cursor is not valid.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("a" in parsed) ||
    !("p" in parsed) ||
    typeof (parsed as { a: unknown }).a !== "number" ||
    !Number.isSafeInteger((parsed as { a: number }).a) ||
    (parsed as { a: number }).a < 0 ||
    typeof (parsed as { p: unknown }).p !== "string" ||
    !ULID_PATTERN.test((parsed as { p: string }).p)
  ) {
    throw validation("INVALID_CURSOR", "Pagination cursor is not valid.");
  }
  return {
    acceptedAt: new Date((parsed as { a: number }).a),
    publicId: (parsed as { p: string }).p,
  };
}

/**
 * OWASP CSV formula injection neutralization + RFC 4180 cell encoding.
 * Cells starting with `=`, `+`, `-`, `@`, TAB, CR, full-width formula prefixes,
 * or leading whitespace/newlines before those characters are prefixed with `'`.
 */
export function escapeAcceptanceCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[\s\u00A0]*[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text) || text !== text.trim()) {
    text = `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function compareKeysetDesc(
  a: { acceptedAt: Date; publicId: string },
  b: { acceptedAt: Date; publicId: string },
): number {
  const diff = b.acceptedAt.getTime() - a.acceptedAt.getTime();
  if (diff !== 0) return diff;
  if (b.publicId === a.publicId) return 0;
  return b.publicId > a.publicId ? 1 : -1;
}

function escapeLikePrefix(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

interface PolicyCatalogSnapshot {
  docsById: Map<number, PolicyDocumentRow>;
  docsByPublicId: Map<string, PolicyDocumentRow>;
  versionsById: Map<number, PolicyVersionRow>;
  versionsByPublicId: Map<string, PolicyVersionRow>;
  /** Map from `documentId` -> active current published version (`doc.active === true` && `status === "published"` && `origin === "portal"` && `effectiveAt <= now`). */
  currentVersionByDocId: Map<number, PolicyVersionRow>;
  currentVersionIds: Set<number>;
}

interface RawUnifiedCandidate {
  evidenceKind: AcceptanceEvidenceKind;
  publicId: string;
  acceptedAt: Date;
  userId: number | null;
  documentId: number;
  versionId: number;
  contentHash: string;
  storedContext: PolicyAcceptanceContext | null;
  rawAccountMethod: PolicyAcceptanceMethod | null;
  origin: "portal" | "import";
  method: AcceptanceLogMethod;
  hasTypedSignature: boolean;
  orderPublicId: string | null;
  gateKey: string | null;
  addressPseudonym: string | null;
  correlationId: string | null;
}

function mapAccountMethod(
  rawMethod: PolicyAcceptanceMethod,
  origin: "portal" | "import",
): AcceptanceLogMethod {
  if (origin === "import" || rawMethod === "imported_historical") return "imported";
  if (rawMethod === "typed_signature") return "typed_signature";
  return "checkbox";
}

/* ------------------------------------------------------------------ service factory */

export function createAcceptanceLogService(deps: ModuleDeps) {
  function identityPort() {
    return (deps.services as Partial<typeof deps.services>).identity;
  }

  function ordersPort() {
    return (deps.services as Partial<typeof deps.services>).orders;
  }

  function acceptancePort() {
    return (deps.services as Partial<typeof deps.services>).compliance?.acceptance;
  }

  async function recordAuthzDenial(
    principal: SessionPrincipal,
    reasonCode: string,
    procedure: string,
    resourcePublicId?: string,
  ): Promise<void> {
    await deps.audit.record({
      category: "security",
      eventName: "authz.compliance.denied",
      action: "authorize",
      outcome: "denied",
      severity: "WARN",
      reasonCode,
      actor: { userId: principal.userId, role: principal.role },
      resource: {
        type: "policy_acceptance_log",
        ...(resourcePublicId ? { publicId: resourcePublicId } : {}),
      },
      attributes: { procedure },
    });
  }

  /**
   * Enforces Increment 05 §4 authorization for read procedures:
   *   - Re-checks live user status & session currency.
   *   - `customer` receives `NOT_FOUND` (no admin surface existence oracle).
   *   - `staff`/`admin` without `policies.acceptances.read` receives `FORBIDDEN`.
   */
  async function authorizeRead(
    principal: SessionPrincipal,
    procedure: string,
    resourcePublicId?: string,
  ): Promise<{ userId: number; role: "staff" | "admin" }> {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) {
      throw new DomainError(
        "REMEDIATION_REQUIRED",
        "ACCOUNT_STEP_PENDING",
        "Please finish securing your account to continue.",
      );
    }

    const identity = identityPort();
    if (identity?.sessions?.getState) {
      const sessionState = await identity.sessions.getState(principal.sessionId);
      if (!sessionState || !sessionState.live) {
        throw new DomainError(
          "UNAUTHENTICATED",
          "SESSION_NOT_CURRENT",
          "Your session is no longer active. Please sign in again.",
        );
      }
    }

    const [liveUser] = await deps.db
      .select({ id: users.id, role: users.role, status: users.status })
      .from(users)
      .where(eq(users.id, principal.userId))
      .limit(1);

    if (!liveUser || liveUser.status !== "active") {
      throw new DomainError(
        "UNAUTHENTICATED",
        "SESSION_NOT_CURRENT",
        "Your session is no longer active. Please sign in again.",
      );
    }

    if (liveUser.role === "customer" || principal.role === "customer") {
      await recordAuthzDenial(principal, "ADMIN_SURFACE_HIDDEN", procedure, resourcePublicId);
      throw notFound("NOT_FOUND");
    }

    if (!roleHasCapability(liveUser.role, "policies.acceptances.read")) {
      await recordAuthzDenial(principal, "CAPABILITY_NOT_GRANTED", procedure, resourcePublicId);
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }

    return { userId: liveUser.id, role: liveUser.role };
  }

  async function loadCatalog(dbOrTx: DbOrTx, now: Date): Promise<PolicyCatalogSnapshot> {
    const [docs, versions] = await Promise.all([
      dbOrTx
        .select()
        .from(policyDocuments)
        .orderBy(desc(policyDocuments.active), asc(policyDocuments.title), asc(policyDocuments.id)),
      dbOrTx
        .select()
        .from(policyVersions)
        .orderBy(desc(policyVersions.versionNumber), desc(policyVersions.id)),
    ]);

    const docsById = new Map<number, PolicyDocumentRow>();
    const docsByPublicId = new Map<string, PolicyDocumentRow>();
    for (const d of docs) {
      docsById.set(d.id, d);
      docsByPublicId.set(d.publicId, d);
    }

    const versionsById = new Map<number, PolicyVersionRow>();
    const versionsByPublicId = new Map<string, PolicyVersionRow>();
    const currentVersionByDocId = new Map<number, PolicyVersionRow>();
    const currentVersionIds = new Set<number>();

    for (const v of versions) {
      versionsById.set(v.id, v);
      versionsByPublicId.set(v.publicId, v);
      const doc = docsById.get(v.documentId);
      if (
        doc &&
        doc.active &&
        v.status === "published" &&
        v.origin === "portal" &&
        v.effectiveAt.getTime() <= now.getTime() &&
        !currentVersionByDocId.has(doc.id)
      ) {
        currentVersionByDocId.set(doc.id, v);
        currentVersionIds.add(v.id);
      }
    }

    return {
      docsById,
      docsByPublicId,
      versionsById,
      versionsByPublicId,
      currentVersionByDocId,
      currentVersionIds,
    };
  }

  /**
   * Batch user lookup via `identity.getUsersByIds`, with safe fallback for unit-test harnesses
   * that seed `users` rows with `enc:<plain>` without mounting the full identity service.
   */
  async function loadUsersByIds(
    dbOrTx: DbOrTx,
    rawIds: readonly number[],
  ): Promise<Map<number, { id: number; publicId: string; name: string; email: string; customerRef: string | null; role: "customer" | "staff" | "admin"; status: UserStatus; createdAt: Date }>> {
    const distinctIds = [...new Set(rawIds)];
    const out = new Map<
      number,
      {
        id: number;
        publicId: string;
        name: string;
        email: string;
        customerRef: string | null;
        role: "customer" | "staff" | "admin";
        status: UserStatus;
        createdAt: Date;
      }
    >();
    if (distinctIds.length === 0) return out;

    const identity = identityPort();
    for (const chunk of chunkArray(distinctIds, EVIDENCE_MAX_IDS)) {
      if (identity?.getUsersByIds) {
        const map: Map<number, UserView> = await identity.getUsersByIds(chunk, { tx: dbOrTx });
        for (const [id, u] of map.entries()) {
          out.set(id, {
            id: u.id,
            publicId: u.publicId,
            name: u.name,
            email: u.email,
            customerRef: u.customerRef,
            role: u.role,
            status: u.status,
            createdAt: u.createdAt,
          });
        }
      } else {
        const rows = await dbOrTx
          .select({
            id: users.id,
            publicId: users.publicId,
            nameEnc: users.nameEnc,
            emailEnc: users.emailEnc,
            customerRef: users.customerRef,
            role: users.role,
            status: users.status,
            createdAt: users.createdAt,
          })
          .from(users)
          .where(inArray(users.id, chunk));
        for (const r of rows) {
          const decodeFallback = (enc: string, aad: string): string => {
            if (enc.startsWith("enc:")) return enc.slice(4);
            try {
              return deps.crypto.decrypt(enc, aad);
            } catch {
              return "[Unavailable]";
            }
          };
          out.set(r.id, {
            id: r.id,
            publicId: r.publicId,
            name: decodeFallback(r.nameEnc, `users.name:${r.publicId}`),
            email: decodeFallback(r.emailEnc, `users.email:${r.publicId}`),
            customerRef: r.customerRef,
            role: r.role,
            status: r.status,
            createdAt: r.createdAt,
          });
        }
      }
    }
    return out;
  }

  async function resolveUserByPublicId(
    dbOrTx: DbOrTx,
    publicId: string,
  ): Promise<{ id: number; publicId: string; name: string; email: string; customerRef: string | null; role: "customer" | "staff" | "admin"; status: UserStatus; createdAt: Date } | null> {
    const identity = identityPort();
    if (identity?.getUserByPublicId) {
      const u = await identity.getUserByPublicId(publicId, { tx: dbOrTx });
      if (!u) return null;
      return {
        id: u.id,
        publicId: u.publicId,
        name: u.name,
        email: u.email,
        customerRef: u.customerRef,
        role: u.role,
        status: u.status,
        createdAt: u.createdAt,
      };
    }
    const [row] = await dbOrTx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.publicId, publicId))
      .limit(1);
    if (!row) return null;
    const loaded = await loadUsersByIds(dbOrTx, [row.id]);
    return loaded.get(row.id) ?? null;
  }

  async function findMatchingCustomerIds(
    dbOrTx: DbOrTx,
    query: string,
  ): Promise<number[]> {
    const q = query.normalize("NFC").trim();
    if (!q) return [];
    const identity = identityPort();
    if (identity?.findCustomerIds) {
      return identity.findCustomerIds(q, { limit: EVIDENCE_MAX_IDS, tx: dbOrTx });
    }
    // Unit-test fallback when identity module is not mounted.
    const rows = await dbOrTx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "customer"))
      .limit(EVIDENCE_MAX_IDS);
    const loaded = await loadUsersByIds(
      dbOrTx,
      rows.map((r) => r.id),
    );
    const needle = q.toLowerCase();
    const matched: number[] = [];
    for (const u of loaded.values()) {
      if (
        u.email.toLowerCase() === needle ||
        u.name.toLowerCase().startsWith(needle) ||
        (u.customerRef !== null && u.customerRef.toLowerCase().startsWith(needle))
      ) {
        matched.push(u.id);
      }
    }
    return matched;
  }

  async function findOrdersByReferenceFilter(
    dbOrTx: DbOrTx,
    principal: SessionPrincipal,
    rawRef: string,
  ): Promise<{ orderIds: number[]; orderPublicIds: string[] }> {
    const q = rawRef.normalize("NFC").trim();
    if (!q) return { orderIds: [], orderPublicIds: [] };

    const ordersSvc = ordersPort();
    if (ULID_PATTERN.test(q) && ordersSvc?.getOrderRefByPublicId) {
      const ref = await ordersSvc.getOrderRefByPublicId(q, dbOrTx);
      if (ref) {
        return { orderIds: [ref.id], orderPublicIds: [ref.publicId] };
      }
    }

    try {
      const cond = ULID_PATTERN.test(q)
        ? or(eq(orders.publicId, q), like(orders.reference, `${escapeLikePrefix(q)}%`))
        : like(orders.reference, `${escapeLikePrefix(q)}%`);
      const rows = await dbOrTx
        .select({ id: orders.id, publicId: orders.publicId })
        .from(orders)
        .where(cond)
        .orderBy(desc(orders.id))
        .limit(200);
      if (rows.length > 0) {
        return {
          orderIds: rows.map((r) => r.id),
          orderPublicIds: rows.map((r) => r.publicId),
        };
      }
    } catch {
      // Isolated test DB may omit `orders` table and provide a fake `orders` service instead.
    }

    if (ordersSvc?.searchOrders) {
      const hits = await ordersSvc.searchOrders(principal, q, 20);
      const upper = q.toUpperCase();
      const matched = hits.filter(
        (h) => h.publicId === q || h.reference.toUpperCase().startsWith(upper),
      );
      const ids: number[] = [];
      const pubIds: string[] = [];
      for (const h of matched) {
        pubIds.push(h.publicId);
        if (ordersSvc.getOrderRefByPublicId) {
          const ref = await ordersSvc.getOrderRefByPublicId(h.publicId, dbOrTx);
          if (ref) ids.push(ref.id);
        }
      }
      return { orderIds: ids, orderPublicIds: pubIds };
    }

    return { orderIds: [], orderPublicIds: [] };
  }

  async function loadOrderReferencesByPublicIds(
    dbOrTx: DbOrTx,
    publicIds: readonly string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(publicIds)];
    const out = new Map<string, string>();
    if (unique.length === 0) return out;

    try {
      for (const chunk of chunkArray(unique, 200)) {
        const rows = await dbOrTx
          .select({ publicId: orders.publicId, reference: orders.reference })
          .from(orders)
          .where(inArray(orders.publicId, chunk));
        for (const r of rows) {
          out.set(r.publicId, r.reference);
        }
      }
    } catch {
      // Isolated test DB without `orders` table falls through to `orders.getOrderRefByPublicId`.
    }

    const ordersSvc = ordersPort();
    if (ordersSvc?.getOrderRefByPublicId) {
      for (const pubId of unique) {
        if (!out.has(pubId)) {
          const ref = await ordersSvc.getOrderRefByPublicId(pubId, dbOrTx);
          if (ref) out.set(pubId, ref.reference);
        }
      }
    }

    return out;
  }

  /**
   * Determines which portal `policy_acceptances` rows (`context === 'portal'` or `context === null`,
   * excluding registration/checkout/import) had an earlier acceptance for the same `(userId, documentId)`.
   */
  async function findPortalReacceptanceKeys(
    dbOrTx: DbOrTx,
    candidates: readonly RawUnifiedCandidate[],
  ): Promise<Set<string>> {
    const portalRows = candidates.filter(
      (c) =>
        c.evidenceKind === "account" &&
        c.origin === "portal" &&
        c.storedContext !== "registration" &&
        c.storedContext !== "checkout" &&
        c.rawAccountMethod !== "registration" &&
        c.orderPublicId === null &&
        c.userId !== null,
    );
    const reacceptedPublicIds = new Set<string>();
    if (portalRows.length === 0) return reacceptedPublicIds;

    const userIds = [...new Set(portalRows.map((c) => c.userId!))];
    const docIds = [...new Set(portalRows.map((c) => c.documentId))];

    const allPrior = await dbOrTx
      .select({
        publicId: policyAcceptances.publicId,
        userId: policyAcceptances.userId,
        documentId: policyAcceptances.documentId,
        acceptedAt: policyAcceptances.acceptedAt,
      })
      .from(policyAcceptances)
      .where(
        and(
          inArray(policyAcceptances.userId, userIds),
          inArray(policyAcceptances.documentId, docIds),
        ),
      )
      .orderBy(asc(policyAcceptances.acceptedAt), asc(policyAcceptances.publicId));

    const earliestByPair = new Map<string, { acceptedAt: number; publicId: string }>();
    for (const row of allPrior) {
      const key = `${row.userId}:${row.documentId}`;
      if (!earliestByPair.has(key)) {
        earliestByPair.set(key, { acceptedAt: row.acceptedAt.getTime(), publicId: row.publicId });
      }
    }

    for (const c of portalRows) {
      const key = `${c.userId}:${c.documentId}`;
      const first = earliestByPair.get(key);
      if (
        first &&
        (c.acceptedAt.getTime() > first.acceptedAt ||
          (c.acceptedAt.getTime() === first.acceptedAt && c.publicId > first.publicId))
      ) {
        reacceptedPublicIds.add(c.publicId);
      }
    }
    return reacceptedPublicIds;
  }

  function deriveAccountSource(
    candidate: RawUnifiedCandidate,
    userCreatedAt: Date | null,
    reacceptedIds: ReadonlySet<string>,
  ): AcceptanceLogSource {
    if (candidate.origin === "import" || candidate.rawAccountMethod === "imported_historical") {
      return "imported_historical";
    }
    if (candidate.storedContext === "registration" || candidate.rawAccountMethod === "registration") {
      return "registration";
    }
    if (candidate.storedContext === "checkout" || candidate.orderPublicId !== null) {
      return "checkout";
    }
    if (reacceptedIds.has(candidate.publicId)) {
      return "portal_reacceptance";
    }
    if (
      candidate.storedContext === null &&
      userCreatedAt !== null &&
      Math.abs(candidate.acceptedAt.getTime() - userCreatedAt.getTime()) <=
        LEGACY_REGISTRATION_WINDOW_MS
    ) {
      return "registration";
    }
    return "portal_acceptance";
  }

  function deriveFreshness(
    version: PolicyVersionRow,
    catalog: PolicyCatalogSnapshot,
  ): {
    freshness: AcceptanceFreshness;
    supersededByVersionPublicId: string | null;
    supersededByVersionLabel: string | null;
  } {
    const current = catalog.currentVersionByDocId.get(version.documentId);
    if (current && current.id === version.id) {
      return {
        freshness: "current",
        supersededByVersionPublicId: null,
        supersededByVersionLabel: null,
      };
    }
    return {
      freshness: "superseded",
      supersededByVersionPublicId: current ? current.publicId : null,
      supersededByVersionLabel: current ? current.versionLabel : null,
    };
  }

  interface ResolvedStreamQuery {
    impossible: boolean;
    userIds: number[] | undefined;
    documentIds: number[] | undefined;
    versionIds: number[] | undefined;
    excludeVersionIds: number[] | undefined;
    orderIds: number[] | undefined;
    orderPublicIds: string[] | undefined;
    from: Date | undefined;
    to: Date | undefined;
    source: AcceptanceLogSource | undefined;
    method: AcceptanceLogMethod | undefined;
    freshness: AcceptanceFreshness | undefined;
  }

  async function resolveStreamFilters(
    dbOrTx: DbOrTx,
    principal: SessionPrincipal,
    catalog: PolicyCatalogSnapshot,
    filter: AcceptanceLogFilterInput,
  ): Promise<ResolvedStreamQuery> {
    const empty: ResolvedStreamQuery = {
      impossible: true,
      userIds: [],
      documentIds: undefined,
      versionIds: undefined,
      excludeVersionIds: undefined,
      orderIds: undefined,
      orderPublicIds: undefined,
      from: filter.from,
      to: filter.to,
      source: filter.source,
      method: filter.method,
      freshness: filter.freshness,
    };

    if (filter.from && filter.to && filter.from.getTime() >= filter.to.getTime()) {
      return empty;
    }

    // Source vs method incompatibilities:
    if (filter.source === "order_gate" && filter.method === "imported") {
      return empty;
    }
    if (filter.source === "imported_historical" && filter.method && filter.method !== "imported") {
      return empty;
    }

    let userIds: number[] | undefined;
    if (filter.customerPublicId) {
      const u = await resolveUserByPublicId(dbOrTx, filter.customerPublicId);
      if (!u) return empty;
      userIds = [u.id];
    }
    if (filter.customerQuery) {
      const matched = await findMatchingCustomerIds(dbOrTx, filter.customerQuery);
      if (matched.length === 0) return empty;
      if (userIds) {
        const set = new Set(matched);
        userIds = userIds.filter((id) => set.has(id));
        if (userIds.length === 0) return empty;
      } else {
        userIds = matched;
      }
    }

    let documentIds: number[] | undefined;
    if (filter.policyDocumentPublicId) {
      const doc = catalog.docsByPublicId.get(filter.policyDocumentPublicId);
      if (!doc) return empty;
      documentIds = [doc.id];
    }

    let versionIds: number[] | undefined;
    if (filter.versionPublicId) {
      const ver = catalog.versionsByPublicId.get(filter.versionPublicId);
      if (!ver) return empty;
      if (documentIds && !documentIds.includes(ver.documentId)) return empty;
      versionIds = [ver.id];
    }

    let excludeVersionIds: number[] | undefined;
    if (filter.freshness === "current") {
      const currentIds = [...catalog.currentVersionIds];
      if (currentIds.length === 0) return empty;
      if (versionIds) {
        versionIds = versionIds.filter((id) => catalog.currentVersionIds.has(id));
        if (versionIds.length === 0) return empty;
      } else if (currentIds.length <= EVIDENCE_MAX_IDS) {
        versionIds = currentIds;
      }
    } else if (filter.freshness === "superseded") {
      if (versionIds) {
        versionIds = versionIds.filter((id) => !catalog.currentVersionIds.has(id));
        if (versionIds.length === 0) return empty;
      } else {
        const currentIds = [...catalog.currentVersionIds];
        if (currentIds.length > 0) {
          excludeVersionIds = currentIds;
        }
      }
    }

    let orderIds: number[] | undefined;
    let orderPublicIds: string[] | undefined;
    if (filter.orderReference) {
      const matchedOrders = await findOrdersByReferenceFilter(
        dbOrTx,
        principal,
        filter.orderReference,
      );
      if (matchedOrders.orderIds.length === 0 && matchedOrders.orderPublicIds.length === 0) {
        return empty;
      }
      orderIds = matchedOrders.orderIds;
      orderPublicIds = matchedOrders.orderPublicIds;
    }

    return {
      impossible: false,
      userIds,
      documentIds,
      versionIds,
      excludeVersionIds,
      orderIds,
      orderPublicIds,
      from: filter.from,
      to: filter.to,
      source: filter.source,
      method: filter.method,
      freshness: filter.freshness,
    };
  }

  async function fetchAccountCandidatesBatch(
    dbOrTx: DbOrTx,
    resolved: ResolvedStreamQuery,
    before: KeysetCursor | undefined,
    batchLimit: number,
  ): Promise<{ items: RawUnifiedCandidate[]; hasMore: boolean }> {
    if (resolved.source === "order_gate") {
      return { items: [], hasMore: false };
    }
    if (resolved.orderPublicIds !== undefined && resolved.orderPublicIds.length === 0) {
      return { items: [], hasMore: false };
    }

    let methodCondition: SQL | undefined;
    if (resolved.method === "checkbox") {
      methodCondition = and(
        eq(policyAcceptances.origin, "portal"),
        inArray(policyAcceptances.method, ["portal_checkbox", "registration"]),
      );
    } else if (resolved.method === "typed_signature") {
      methodCondition = and(
        eq(policyAcceptances.origin, "portal"),
        eq(policyAcceptances.method, "typed_signature"),
      );
    } else if (resolved.method === "imported") {
      methodCondition = or(
        eq(policyAcceptances.origin, "import"),
        eq(policyAcceptances.method, "imported_historical"),
      );
    }

    const conditions: (SQL | undefined)[] = [
      resolved.userIds ? inArray(policyAcceptances.userId, resolved.userIds) : undefined,
      resolved.documentIds ? inArray(policyAcceptances.documentId, resolved.documentIds) : undefined,
      resolved.versionIds
        ? inArray(policyAcceptances.policyVersionId, resolved.versionIds)
        : undefined,
      resolved.excludeVersionIds && resolved.excludeVersionIds.length > 0
        ? notInArray(policyAcceptances.policyVersionId, resolved.excludeVersionIds)
        : undefined,
      resolved.orderPublicIds
        ? inArray(policyAcceptances.orderPublicId, resolved.orderPublicIds)
        : undefined,
      methodCondition,
      resolved.from ? gte(policyAcceptances.acceptedAt, resolved.from) : undefined,
      resolved.to ? lt(policyAcceptances.acceptedAt, resolved.to) : undefined,
      before
        ? or(
            lt(policyAcceptances.acceptedAt, before.acceptedAt),
            and(
              eq(policyAcceptances.acceptedAt, before.acceptedAt),
              lt(policyAcceptances.publicId, before.publicId),
            ),
          )
        : undefined,
    ];

    if (resolved.source === "imported_historical") {
      conditions.push(
        or(
          eq(policyAcceptances.origin, "import"),
          eq(policyAcceptances.method, "imported_historical"),
        ),
      );
    } else if (resolved.source === "registration") {
      conditions.push(
        and(
          eq(policyAcceptances.origin, "portal"),
          or(
            eq(policyAcceptances.context, "registration"),
            eq(policyAcceptances.method, "registration"),
            isNull(policyAcceptances.context),
          ),
        ),
      );
    } else if (resolved.source === "checkout") {
      conditions.push(
        and(
          eq(policyAcceptances.origin, "portal"),
          or(
            eq(policyAcceptances.context, "checkout"),
            isNull(policyAcceptances.context),
          ),
        ),
      );
    } else if (
      resolved.source === "portal_acceptance" ||
      resolved.source === "portal_reacceptance"
    ) {
      conditions.push(
        and(
          eq(policyAcceptances.origin, "portal"),
          or(eq(policyAcceptances.context, "portal"), isNull(policyAcceptances.context)),
        ),
      );
    }

    const rows = await dbOrTx
      .select({
        publicId: policyAcceptances.publicId,
        acceptedAt: policyAcceptances.acceptedAt,
        userId: policyAcceptances.userId,
        documentId: policyAcceptances.documentId,
        policyVersionId: policyAcceptances.policyVersionId,
        versionContentHash: policyAcceptances.versionContentHash,
        context: policyAcceptances.context,
        origin: policyAcceptances.origin,
        method: policyAcceptances.method,
        signerNameEnc: policyAcceptances.signerNameEnc,
        orderPublicId: policyAcceptances.orderPublicId,
        sourceAddressPseudonym: policyAcceptances.sourceAddressPseudonym,
        requestId: policyAcceptances.requestId,
      })
      .from(policyAcceptances)
      .where(and(...conditions))
      .orderBy(desc(policyAcceptances.acceptedAt), desc(policyAcceptances.publicId))
      .limit(batchLimit + 1);

    const sliced = rows.slice(0, batchLimit).map(
      (r): RawUnifiedCandidate => ({
        evidenceKind: "account",
        publicId: r.publicId,
        acceptedAt: r.acceptedAt,
        userId: r.userId,
        documentId: r.documentId,
        versionId: r.policyVersionId,
        contentHash: r.versionContentHash,
        storedContext: r.context,
        rawAccountMethod: r.method,
        origin: r.origin,
        method: mapAccountMethod(r.method, r.origin),
        hasTypedSignature: r.signerNameEnc !== null,
        orderPublicId: r.orderPublicId,
        gateKey: null,
        addressPseudonym: r.sourceAddressPseudonym,
        correlationId: r.requestId,
      }),
    );

    return { items: sliced, hasMore: rows.length > batchLimit };
  }

  async function fetchOrderGateCandidatesBatch(
    dbOrTx: DbOrTx,
    catalog: PolicyCatalogSnapshot,
    resolved: ResolvedStreamQuery,
    before: KeysetCursor | undefined,
    batchLimit: number,
  ): Promise<{ items: RawUnifiedCandidate[]; hasMore: boolean }> {
    const acc = acceptancePort();
    if (!acc?.evidencePage) {
      return { items: [], hasMore: false };
    }
    if (resolved.source !== undefined && resolved.source !== "order_gate") {
      return { items: [], hasMore: false };
    }
    if (resolved.method === "imported") {
      return { items: [], hasMore: false };
    }
    if (resolved.orderIds !== undefined && resolved.orderIds.length === 0) {
      return { items: [], hasMore: false };
    }

    let effectiveVersionIds = resolved.versionIds;
    if (!effectiveVersionIds && resolved.excludeVersionIds && resolved.excludeVersionIds.length > 0) {
      const nonCurrentIds = [...catalog.versionsById.keys()].filter(
        (id) => !catalog.currentVersionIds.has(id),
      );
      if (nonCurrentIds.length === 0) {
        return { items: [], hasMore: false };
      }
      if (nonCurrentIds.length <= EVIDENCE_MAX_IDS) {
        effectiveVersionIds = nonCurrentIds;
      }
    }

    const page = await acc.evidencePage(
      {
        userIds: resolved.userIds,
        policyDocumentIds: resolved.documentIds,
        policyVersionIds: effectiveVersionIds,
        orderIds: resolved.orderIds,
        method:
          resolved.method === "checkbox"
            ? "checkbox"
            : resolved.method === "typed_signature"
              ? "typed_name"
              : undefined,
        from: resolved.from,
        to: resolved.to,
        before,
        limit: Math.min(batchLimit, EVIDENCE_MAX_LIMIT),
      },
      { tx: dbOrTx },
    );

    const mapped = page.items.map(
      (item: OrderGateEvidence): RawUnifiedCandidate => ({
        evidenceKind: "order_gate",
        publicId: item.publicId,
        acceptedAt: item.acceptedAt,
        userId: item.userId,
        documentId: item.policyDocumentId,
        versionId: item.policyVersionId,
        contentHash: item.textSha256,
        storedContext: null,
        rawAccountMethod: null,
        origin: "portal",
        method: item.method === "typed_name" ? "typed_signature" : "checkbox",
        hasTypedSignature: item.signerNameEnc !== null,
        orderPublicId: item.orderPublicId,
        gateKey: item.gateKey,
        addressPseudonym: item.addressPseudonym,
        correlationId: item.correlationId,
      }),
    );

    return { items: mapped, hasMore: page.hasMore };
  }

  /**
   * Hydrates raw candidates into `AcceptanceLogItem`s (explicitly omitting `typedSignerName`!),
   * applying any residual JS refinement for legacy `context IS NULL` rows or `freshness`.
   */
  async function hydrateAndFilterCandidates(
    dbOrTx: DbOrTx,
    catalog: PolicyCatalogSnapshot,
    resolved: ResolvedStreamQuery,
    candidates: readonly RawUnifiedCandidate[],
  ): Promise<AcceptanceLogItem[]> {
    if (candidates.length === 0) return [];

    const userIds = candidates
      .map((c) => c.userId)
      .filter((id): id is number => id !== null);
    const orderPubIds = candidates
      .map((c) => c.orderPublicId)
      .filter((id): id is string => id !== null);

    const [usersById, orderRefsByPubId, reacceptedIds] = await Promise.all([
      loadUsersByIds(dbOrTx, userIds),
      loadOrderReferencesByPublicIds(dbOrTx, orderPubIds),
      findPortalReacceptanceKeys(dbOrTx, candidates),
    ]);

    const items: AcceptanceLogItem[] = [];
    for (const c of candidates) {
      const doc = catalog.docsById.get(c.documentId);
      const ver = catalog.versionsById.get(c.versionId);
      if (!doc || !ver) continue;

      const user = c.userId !== null ? usersById.get(c.userId) ?? null : null;
      const source: AcceptanceLogSource =
        c.evidenceKind === "order_gate"
          ? "order_gate"
          : deriveAccountSource(c, user?.createdAt ?? null, reacceptedIds);

      if (resolved.source && source !== resolved.source) continue;

      const { freshness, supersededByVersionPublicId, supersededByVersionLabel } =
        deriveFreshness(ver, catalog);
      if (resolved.freshness && freshness !== resolved.freshness) continue;

      // IMPORTANT (privacy review): `typedSignerName` MUST NOT exist as a key on `AcceptanceLogItem`.
      const item: AcceptanceLogItem = {
        publicId: c.publicId,
        evidenceKind: c.evidenceKind,
        acceptedAt: c.acceptedAt,
        customer: user
          ? {
              userPublicId: user.publicId,
              name: user.name,
              email: user.email,
              customerRef: user.customerRef,
            }
          : null,
        policyDocumentPublicId: doc.publicId,
        policySlug: doc.slug,
        policyTitle: doc.title,
        versionPublicId: ver.publicId,
        versionNumber: ver.versionNumber,
        versionLabel: ver.versionLabel,
        contentHash: c.contentHash,
        shortContentHash: c.contentHash.slice(0, 12),
        source,
        method: c.method,
        hasTypedSignature: c.hasTypedSignature,
        freshness,
        supersededByVersionPublicId,
        supersededByVersionLabel,
        orderPublicId: c.orderPublicId,
        orderReference: c.orderPublicId ? orderRefsByPubId.get(c.orderPublicId) ?? null : null,
        gateKey: c.gateKey,
        addressPseudonym: c.addressPseudonym,
        correlationId: c.correlationId,
        origin: c.origin,
      };
      items.push(item);
    }

    return items;
  }

  /**
   * Collects up to `targetCount` unified `AcceptanceLogItem`s newest-first across both evidence tables,
   * advancing the shared keyset cursor cleanly across batches when post-refinement filters skip legacy rows.
   */
  async function queryUnifiedStream(
    dbOrTx: DbOrTx,
    principal: SessionPrincipal,
    filter: AcceptanceLogFilterInput,
    initialCursor: KeysetCursor | undefined,
    targetCount: number,
  ): Promise<{ items: AcceptanceLogItem[]; hasMore: boolean }> {
    const now = deps.clock.now();
    const catalog = await loadCatalog(dbOrTx, now);
    const resolved = await resolveStreamFilters(dbOrTx, principal, catalog, filter);
    if (resolved.impossible) {
      return { items: [], hasMore: false };
    }

    const collected: AcceptanceLogItem[] = [];
    let cursor = initialCursor;
    let exhausted = false;

    while (collected.length <= targetCount && !exhausted) {
      const remaining = targetCount + 1 - collected.length;
      const batchSize = Math.min(Math.max(remaining, 50), EVIDENCE_MAX_LIMIT - 1);

      const [acctBatch, gateBatch] = await Promise.all([
        fetchAccountCandidatesBatch(dbOrTx, resolved, cursor, batchSize),
        fetchOrderGateCandidatesBatch(dbOrTx, catalog, resolved, cursor, batchSize),
      ]);

      if (acctBatch.items.length === 0 && gateBatch.items.length === 0) {
        break;
      }

      // Compute safe merge horizon so neither stream skips unseen items older than the exhausted stream's tail.
      const acctTail = acctBatch.hasMore
        ? acctBatch.items[acctBatch.items.length - 1]
        : undefined;
      const gateTail = gateBatch.hasMore
        ? gateBatch.items[gateBatch.items.length - 1]
        : undefined;

      let horizon: KeysetCursor | undefined;
      if (acctTail && gateTail) {
        horizon =
          compareKeysetDesc(acctTail, gateTail) <= 0
            ? { acceptedAt: acctTail.acceptedAt, publicId: acctTail.publicId }
            : { acceptedAt: gateTail.acceptedAt, publicId: gateTail.publicId };
      } else if (acctTail) {
        horizon = { acceptedAt: acctTail.acceptedAt, publicId: acctTail.publicId };
      } else if (gateTail) {
        horizon = { acceptedAt: gateTail.acceptedAt, publicId: gateTail.publicId };
      }

      const merged = [...acctBatch.items, ...gateBatch.items].sort(compareKeysetDesc);
      const safeWindow = horizon
        ? merged.filter((m) => compareKeysetDesc(m, horizon) <= 0)
        : merged;

      // Guarantee forward progress even if every row in one batch was older than the other stream's horizon.
      const windowToProcess = safeWindow.length > 0 ? safeWindow : merged.slice(0, 1);
      const hydrated = await hydrateAndFilterCandidates(
        dbOrTx,
        catalog,
        resolved,
        windowToProcess,
      );
      collected.push(...hydrated);

      if (!acctBatch.hasMore && !gateBatch.hasMore && windowToProcess.length === merged.length) {
        exhausted = true;
      } else {
        const lastProcessed = windowToProcess[windowToProcess.length - 1]!;
        cursor = {
          acceptedAt: lastProcessed.acceptedAt,
          publicId: lastProcessed.publicId,
        };
      }
    }

    const hasMore = collected.length > targetCount;
    return {
      items: collected.slice(0, targetCount),
      hasMore,
    };
  }

  /* ------------------------------------------------------------------ 1. filterOptions */

  async function filterOptions(principal: SessionPrincipal): Promise<AcceptanceFilterOptionsView> {
    await authorizeRead(principal, "compliance.policies.admin.acceptanceLog.filterOptions");
    const now = deps.clock.now();
    const catalog = await loadCatalog(deps.db, now);

    const publishedVersionsByDoc = new Map<number, PolicyVersionRow[]>();
    for (const v of catalog.versionsById.values()) {
      if (v.status !== "published") continue;
      const arr = publishedVersionsByDoc.get(v.documentId) ?? [];
      arr.push(v);
      publishedVersionsByDoc.set(v.documentId, arr);
    }

    return {
      policies: [...catalog.docsById.values()].map((doc) => {
        const current = catalog.currentVersionByDocId.get(doc.id);
        const versions = (publishedVersionsByDoc.get(doc.id) ?? []).map((ver) => ({
          versionPublicId: ver.publicId,
          versionNumber: ver.versionNumber,
          versionLabel: ver.versionLabel,
          publishedAt: ver.publishedAt,
          isCurrent: current?.id === ver.id,
        }));
        return {
          documentPublicId: doc.publicId,
          slug: doc.slug,
          title: doc.title,
          audience: doc.audience,
          active: doc.active,
          requiresAcceptance: doc.requiresAcceptance,
          versions,
        };
      }),
    };
  }

  /* ------------------------------------------------------------------ 2. list */

  async function list(
    principal: SessionPrincipal,
    input: AcceptanceLogListInput = {},
  ): Promise<{ items: AcceptanceLogItem[]; nextCursor: string | null }> {
    await authorizeRead(principal, "compliance.policies.admin.acceptanceLog.list");
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT);
    const cursor = decodeAcceptanceLogCursor(input.cursor);

    const { items, hasMore } = await queryUnifiedStream(
      deps.db,
      principal,
      input,
      cursor,
      limit,
    );
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeAcceptanceLogCursor({ acceptedAt: last.acceptedAt, publicId: last.publicId })
          : null,
    };
  }

  /* ------------------------------------------------------------------ 3. detail */

  async function detail(
    principal: SessionPrincipal,
    input: { publicId: string },
  ): Promise<AcceptanceLogDetailView> {
    const liveActor = await authorizeRead(
      principal,
      "compliance.policies.admin.acceptanceLog.detail",
      input.publicId,
    );
    const canViewSignerName = roleHasCapability(liveActor.role, "policies.manage");
    const now = deps.clock.now();
    const catalog = await loadCatalog(deps.db, now);

    // 1. Check `policy_acceptances` first.
    const [acctRow] = await deps.db
      .select()
      .from(policyAcceptances)
      .where(eq(policyAcceptances.publicId, input.publicId))
      .limit(1);

    if (acctRow) {
      const ver = catalog.versionsById.get(acctRow.policyVersionId);
      const doc = catalog.docsById.get(acctRow.documentId);
      if (!ver || !doc) throw notFound("ACCEPTANCE_NOT_FOUND");

      const candidate: RawUnifiedCandidate = {
        evidenceKind: "account",
        publicId: acctRow.publicId,
        acceptedAt: acctRow.acceptedAt,
        userId: acctRow.userId,
        documentId: acctRow.documentId,
        versionId: acctRow.policyVersionId,
        contentHash: acctRow.versionContentHash,
        storedContext: acctRow.context,
        rawAccountMethod: acctRow.method,
        origin: acctRow.origin,
        method: mapAccountMethod(acctRow.method, acctRow.origin),
        hasTypedSignature: acctRow.signerNameEnc !== null,
        orderPublicId: acctRow.orderPublicId,
        gateKey: null,
        addressPseudonym: acctRow.sourceAddressPseudonym,
        correlationId: acctRow.requestId,
      };

      const emptyResolved: ResolvedStreamQuery = {
        impossible: false,
        userIds: undefined,
        documentIds: undefined,
        versionIds: undefined,
        excludeVersionIds: undefined,
        orderIds: undefined,
        orderPublicIds: undefined,
        from: undefined,
        to: undefined,
        source: undefined,
        method: undefined,
        freshness: undefined,
      };
      const [baseItem] = await hydrateAndFilterCandidates(deps.db, catalog, emptyResolved, [
        candidate,
      ]);
      if (!baseItem) throw notFound("ACCEPTANCE_NOT_FOUND");

      const hasSig = acctRow.signerNameEnc !== null;
      let typedSignerName: string | null = null;
      let signerNameRedacted = false;
      if (hasSig) {
        if (canViewSignerName) {
          typedSignerName = deps.crypto.decrypt(
            acctRow.signerNameEnc!,
            signerNameAad(acctRow.publicId),
          );
          signerNameRedacted = false;
        } else {
          typedSignerName = null;
          signerNameRedacted = true;
        }
      }

      return {
        ...baseItem,
        contentFormat: ver.contentFormat,
        bodyText: ver.bodyText,
        effectiveAt: ver.effectiveAt,
        publishedAt: ver.publishedAt,
        typedSignerName,
        signerNameRedacted,
      };
    }

    // 2. Check `order_policy_acceptances` via `compliance.acceptance.evidencePage`.
    const [gateRef] = await deps.db
      .select({
        publicId: orderPolicyAcceptances.publicId,
        userId: orderPolicyAcceptances.userId,
        policyVersionId: orderPolicyAcceptances.policyVersionId,
        acceptedAt: orderPolicyAcceptances.acceptedAt,
      })
      .from(orderPolicyAcceptances)
      .where(eq(orderPolicyAcceptances.publicId, input.publicId))
      .limit(1);

    if (!gateRef) {
      throw notFound("ACCEPTANCE_NOT_FOUND");
    }

    const acc = acceptancePort();
    if (!acc?.evidencePage) {
      throw notFound("ACCEPTANCE_NOT_FOUND");
    }

    const page = await acc.evidencePage({
      userIds: [gateRef.userId],
      policyVersionIds: [gateRef.policyVersionId],
      from: gateRef.acceptedAt,
      to: new Date(gateRef.acceptedAt.getTime() + 1),
      limit: 50,
    });
    const gateItem = page.items.find((it) => it.publicId === input.publicId);
    if (!gateItem) {
      throw notFound("ACCEPTANCE_NOT_FOUND");
    }

    const ver = catalog.versionsById.get(gateItem.policyVersionId);
    const doc = catalog.docsById.get(gateItem.policyDocumentId);
    if (!ver || !doc) throw notFound("ACCEPTANCE_NOT_FOUND");

    const candidate: RawUnifiedCandidate = {
      evidenceKind: "order_gate",
      publicId: gateItem.publicId,
      acceptedAt: gateItem.acceptedAt,
      userId: gateItem.userId,
      documentId: gateItem.policyDocumentId,
      versionId: gateItem.policyVersionId,
      contentHash: gateItem.textSha256,
      storedContext: null,
      rawAccountMethod: null,
      origin: "portal",
      method: gateItem.method === "typed_name" ? "typed_signature" : "checkbox",
      hasTypedSignature: gateItem.signerNameEnc !== null,
      orderPublicId: gateItem.orderPublicId,
      gateKey: gateItem.gateKey,
      addressPseudonym: gateItem.addressPseudonym,
      correlationId: gateItem.correlationId,
    };

    const emptyResolved: ResolvedStreamQuery = {
      impossible: false,
      userIds: undefined,
      documentIds: undefined,
      versionIds: undefined,
      excludeVersionIds: undefined,
      orderIds: undefined,
      orderPublicIds: undefined,
      from: undefined,
      to: undefined,
      source: undefined,
      method: undefined,
      freshness: undefined,
    };
    const [baseItem] = await hydrateAndFilterCandidates(deps.db, catalog, emptyResolved, [
      candidate,
    ]);
    if (!baseItem) throw notFound("ACCEPTANCE_NOT_FOUND");

    const hasSig = gateItem.signerNameEnc !== null && gateItem.signerNameAad !== null;
    let typedSignerName: string | null = null;
    let signerNameRedacted = false;
    if (hasSig) {
      if (canViewSignerName) {
        typedSignerName = deps.crypto.decrypt(gateItem.signerNameEnc!, gateItem.signerNameAad!);
        signerNameRedacted = false;
      } else {
        typedSignerName = null;
        signerNameRedacted = true;
      }
    }

    return {
      ...baseItem,
      contentFormat: ver.contentFormat,
      bodyText: ver.bodyText,
      effectiveAt: ver.effectiveAt,
      publishedAt: ver.publishedAt,
      typedSignerName,
      signerNameRedacted,
    };
  }

  /* ------------------------------------------------------------------ 4. coverage */

  async function coverage(
    principal: SessionPrincipal,
    input: { documentPublicId?: string | undefined; outstandingLimit?: number | undefined } = {},
  ): Promise<PolicyCoverageView> {
    await authorizeRead(
      principal,
      "compliance.policies.admin.acceptanceLog.coverage",
      input.documentPublicId,
    );
    const outstandingLimit = Math.min(
      Math.max(Math.trunc(input.outstandingLimit ?? DEFAULT_OUTSTANDING_LIMIT), 1),
      MAX_OUTSTANDING_LIMIT,
    );
    const now = deps.clock.now();
    const catalog = await loadCatalog(deps.db, now);

    if (input.documentPublicId && !catalog.docsByPublicId.has(input.documentPublicId)) {
      throw notFound("POLICY_DOCUMENT_NOT_FOUND");
    }

    const activeCustomerRows = await deps.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "customer"), eq(users.status, "active")))
      .orderBy(asc(users.id));
    const activeCustomerIds = activeCustomerRows.map((r) => r.id);
    const activeCustomerIdSet = new Set(activeCustomerIds);
    const activeCustomerCount = activeCustomerIds.length;

    const requiredDocs = [...catalog.docsById.values()].filter((doc) => {
      if (input.documentPublicId && doc.publicId !== input.documentPublicId) return false;
      return (
        doc.active &&
        doc.requiresAcceptance &&
        (doc.audience === "customer" || doc.audience === "all") &&
        catalog.currentVersionByDocId.has(doc.id)
      );
    });

    if (requiredDocs.length === 0) {
      return { activeCustomerCount, policies: [] };
    }

    const currentVersionIds = requiredDocs.map(
      (doc) => catalog.currentVersionByDocId.get(doc.id)!.id,
    );

    // 1. Collect acceptors of current versions across `policy_acceptances` + `order_policy_acceptances`.
    const acceptedByVersion = new Map<number, Set<number>>();
    for (const vId of currentVersionIds) acceptedByVersion.set(vId, new Set());

    if (activeCustomerCount > 0) {
      const acctRows = await deps.db
        .selectDistinct({
          versionId: policyAcceptances.policyVersionId,
          userId: policyAcceptances.userId,
        })
        .from(policyAcceptances)
        .where(inArray(policyAcceptances.policyVersionId, currentVersionIds));
      for (const r of acctRows) {
        if (r.userId !== null && activeCustomerIdSet.has(r.userId)) {
          acceptedByVersion.get(r.versionId)?.add(r.userId);
        }
      }

      const acc = acceptancePort();
      if (acc?.acceptorsByVersion) {
        for (const vChunk of chunkArray(currentVersionIds, EVIDENCE_MAX_IDS)) {
          const gateMap = await acc.acceptorsByVersion(vChunk);
          for (const [vId, uIds] of gateMap.entries()) {
            const set = acceptedByVersion.get(vId);
            if (!set) continue;
            for (const uId of uIds) {
              if (activeCustomerIdSet.has(uId)) set.add(uId);
            }
          }
        }
      }
    }

    // 2. Determine outstanding customers per policy and batch-enrich user summaries + last accepted versions.
    const outstandingByDoc = new Map<
      number,
      { totalOutstanding: number; pageIds: number[]; truncated: boolean }
    >();
    const allPageOutstandingUserIds = new Set<number>();

    for (const doc of requiredDocs) {
      const currentVer = catalog.currentVersionByDocId.get(doc.id)!;
      const acceptedSet = acceptedByVersion.get(currentVer.id) ?? new Set<number>();
      const missingIds = activeCustomerIds.filter((uId) => !acceptedSet.has(uId));
      const pageIds = missingIds.slice(0, outstandingLimit);
      for (const id of pageIds) allPageOutstandingUserIds.add(id);
      outstandingByDoc.set(doc.id, {
        totalOutstanding: missingIds.length,
        pageIds,
        truncated: missingIds.length > outstandingLimit,
      });
    }

    const usersById = await loadUsersByIds(deps.db, [...allPageOutstandingUserIds]);

    // Map `${docId}:${userId}` -> newest `{ versionId, acceptedAt }` across both evidence tables.
    const latestPriorByDocUser = new Map<string, { versionId: number; acceptedAt: Date }>();
    const recordPrior = (docId: number, userId: number, versionId: number, acceptedAt: Date) => {
      const key = `${docId}:${userId}`;
      const existing = latestPriorByDocUser.get(key);
      if (!existing || acceptedAt.getTime() > existing.acceptedAt.getTime()) {
        latestPriorByDocUser.set(key, { versionId, acceptedAt });
      }
    };

    if (allPageOutstandingUserIds.size > 0) {
      const requiredDocIds = requiredDocs.map((d) => d.id);
      const userIdList = [...allPageOutstandingUserIds];

      for (const uChunk of chunkArray(userIdList, EVIDENCE_MAX_IDS)) {
        const priorAcctRows = await deps.db
          .select({
            userId: policyAcceptances.userId,
            documentId: policyAcceptances.documentId,
            versionId: policyAcceptances.policyVersionId,
            acceptedAt: policyAcceptances.acceptedAt,
          })
          .from(policyAcceptances)
          .where(
            and(
              inArray(policyAcceptances.userId, uChunk),
              inArray(policyAcceptances.documentId, requiredDocIds),
            ),
          )
          .orderBy(desc(policyAcceptances.acceptedAt), desc(policyAcceptances.publicId));

        for (const r of priorAcctRows) {
          if (r.userId !== null) {
            recordPrior(r.documentId, r.userId, r.versionId, r.acceptedAt);
          }
        }

        const acc = acceptancePort();
        if (acc?.evidencePage) {
          let before: KeysetCursor | undefined;
          let more = true;
          while (more) {
            const gatePage = await acc.evidencePage({
              userIds: uChunk,
              policyDocumentIds: requiredDocIds,
              before,
              limit: EVIDENCE_MAX_LIMIT,
            });
            for (const g of gatePage.items) {
              recordPrior(g.policyDocumentId, g.userId, g.policyVersionId, g.acceptedAt);
            }
            const last = gatePage.items[gatePage.items.length - 1];
            if (gatePage.hasMore && last) {
              before = { acceptedAt: last.acceptedAt, publicId: last.publicId };
            } else {
              more = false;
            }
          }
        }
      }
    }

    const policies: PolicyCoverageDocumentView[] = requiredDocs.map((doc) => {
      const currentVer = catalog.currentVersionByDocId.get(doc.id)!;
      const acceptedSet = acceptedByVersion.get(currentVer.id) ?? new Set<number>();
      const outInfo = outstandingByDoc.get(doc.id)!;

      const outstandingCustomers: PolicyCoverageOutstandingCustomer[] = [];
      for (const uId of outInfo.pageIds) {
        const u = usersById.get(uId);
        if (!u) continue;
        const prior = latestPriorByDocUser.get(`${doc.id}:${uId}`);
        const priorVer = prior ? catalog.versionsById.get(prior.versionId) : undefined;
        outstandingCustomers.push({
          customer: {
            userPublicId: u.publicId,
            name: u.name,
            email: u.email,
            customerRef: u.customerRef,
          },
          lastAcceptedVersionPublicId: priorVer ? priorVer.publicId : null,
          lastAcceptedVersionNumber: priorVer ? priorVer.versionNumber : null,
          lastAcceptedVersionLabel: priorVer ? priorVer.versionLabel : null,
          lastAcceptedAt: prior ? prior.acceptedAt : null,
        });
      }

      return {
        documentPublicId: doc.publicId,
        slug: doc.slug,
        title: doc.title,
        audience: doc.audience,
        currentVersionPublicId: currentVer.publicId,
        currentVersionNumber: currentVer.versionNumber,
        currentVersionLabel: currentVer.versionLabel,
        publishedAt: currentVer.publishedAt,
        effectiveAt: currentVer.effectiveAt,
        activeCustomerCount,
        acceptedCurrentCount: acceptedSet.size,
        outstandingCount: outInfo.totalOutstanding,
        outstandingCustomers,
        outstandingTruncated: outInfo.truncated,
      };
    });

    return { activeCustomerCount, policies };
  }

  /* ------------------------------------------------------------------ 5. updates */

  async function updates(
    principal: SessionPrincipal,
    input: { documentPublicId?: string | undefined } = {},
  ): Promise<{ items: PolicyUpdateHistoryItem[] }> {
    await authorizeRead(
      principal,
      "compliance.policies.admin.acceptanceLog.updates",
      input.documentPublicId,
    );
    const now = deps.clock.now();
    const catalog = await loadCatalog(deps.db, now);

    let scopedDocId: number | undefined;
    if (input.documentPublicId) {
      const doc = catalog.docsByPublicId.get(input.documentPublicId);
      if (!doc) throw notFound("POLICY_DOCUMENT_NOT_FOUND");
      scopedDocId = doc.id;
    }

    const publishedVersions = [...catalog.versionsById.values()]
      .filter(
        (v) =>
          v.status === "published" && (scopedDocId === undefined || v.documentId === scopedDocId),
      )
      .sort((a, b) => {
        const aTime = (a.publishedAt ?? a.effectiveAt).getTime();
        const bTime = (b.publishedAt ?? b.effectiveAt).getTime();
        if (bTime !== aTime) return bTime - aTime;
        if (b.versionNumber !== a.versionNumber) return b.versionNumber - a.versionNumber;
        return b.id - a.id;
      });

    if (publishedVersions.length === 0) {
      return { items: [] };
    }

    const publisherIds = publishedVersions
      .map((v) => v.publishedByUserId)
      .filter((id): id is number => id !== null);
    const publishersById = await loadUsersByIds(deps.db, publisherIds);

    // Distinct customer acceptors per version across `policy_acceptances` and `order_policy_acceptances`.
    const versionIds = publishedVersions.map((v) => v.id);
    const customerAcceptorsByVersion = new Map<number, Set<number>>();
    for (const vId of versionIds) customerAcceptorsByVersion.set(vId, new Set());

    for (const vChunk of chunkArray(versionIds, EVIDENCE_MAX_IDS)) {
      const acctRows = await deps.db
        .selectDistinct({
          versionId: policyAcceptances.policyVersionId,
          userId: policyAcceptances.userId,
        })
        .from(policyAcceptances)
        .innerJoin(users, eq(policyAcceptances.userId, users.id))
        .where(
          and(inArray(policyAcceptances.policyVersionId, vChunk), eq(users.role, "customer")),
        );
      for (const r of acctRows) {
        if (r.userId !== null) {
          customerAcceptorsByVersion.get(r.versionId)?.add(r.userId);
        }
      }

      const acc = acceptancePort();
      if (acc?.acceptorsByVersion) {
        const gateMap = await acc.acceptorsByVersion(vChunk);
        const gateUserIds = new Set<number>();
        for (const uIds of gateMap.values()) {
          for (const id of uIds) gateUserIds.add(id);
        }
        if (gateUserIds.size > 0) {
          const customerRoleIds = new Set<number>();
          for (const uChunk of chunkArray([...gateUserIds], EVIDENCE_MAX_IDS)) {
            const cRows = await deps.db
              .select({ id: users.id })
              .from(users)
              .where(and(inArray(users.id, uChunk), eq(users.role, "customer")));
            for (const c of cRows) customerRoleIds.add(c.id);
          }
          for (const [vId, uIds] of gateMap.entries()) {
            const set = customerAcceptorsByVersion.get(vId);
            if (!set) continue;
            for (const uId of uIds) {
              if (customerRoleIds.has(uId)) set.add(uId);
            }
          }
        }
      }
    }

    const items: PolicyUpdateHistoryItem[] = [];
    for (const ver of publishedVersions) {
      const doc = catalog.docsById.get(ver.documentId);
      if (!doc) continue;
      const current = catalog.currentVersionByDocId.get(doc.id);
      const pubUser =
        ver.publishedByUserId !== null ? publishersById.get(ver.publishedByUserId) ?? null : null;
      items.push({
        documentPublicId: doc.publicId,
        policySlug: doc.slug,
        policyTitle: doc.title,
        audience: doc.audience,
        versionPublicId: ver.publicId,
        versionNumber: ver.versionNumber,
        versionLabel: ver.versionLabel,
        contentHash: ver.contentHash,
        shortContentHash: ver.contentHash.slice(0, 12),
        changeSummary: ver.changeSummary,
        publishedAt: ver.publishedAt,
        effectiveAt: ver.effectiveAt,
        publishedBy: pubUser
          ? { userPublicId: pubUser.publicId, name: pubUser.name, email: pubUser.email }
          : null,
        isCurrent: current?.id === ver.id,
        acceptedCustomerCount: customerAcceptorsByVersion.get(ver.id)?.size ?? 0,
      });
    }

    return { items };
  }

  /* ------------------------------------------------------------------ 6. forCustomer */

  async function forCustomer(
    principal: SessionPrincipal,
    input: {
      customerPublicId: string;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<CustomerPolicyAcceptanceProfileView> {
    await authorizeRead(
      principal,
      "compliance.policies.admin.acceptanceLog.forCustomer",
      input.customerPublicId,
    );
    const limit = Math.min(
      Math.max(Math.trunc(input.limit ?? DEFAULT_FOR_CUSTOMER_LIMIT), 1),
      MAX_LIST_LIMIT,
    );
    const cursor = decodeAcceptanceLogCursor(input.cursor);

    const user = await resolveUserByPublicId(deps.db, input.customerPublicId);
    if (!user || user.role !== "customer") {
      throw notFound("CUSTOMER_NOT_FOUND");
    }

    const now = deps.clock.now();
    const catalog = await loadCatalog(deps.db, now);

    // Compute per-document acceptance state across BOTH `policy_acceptances` and `order_policy_acceptances`.
    const acceptedVersionsByDoc = new Map<
      number,
      { latestOverall: { versionId: number; acceptedAt: Date }; currentAcceptedAt: Date | null }
    >();

    const recordDocAcceptance = (
      docId: number,
      versionId: number,
      acceptedAt: Date,
      currentVersionId: number | undefined,
    ) => {
      const existing = acceptedVersionsByDoc.get(docId);
      const isCurr = currentVersionId !== undefined && versionId === currentVersionId;
      if (!existing) {
        acceptedVersionsByDoc.set(docId, {
          latestOverall: { versionId, acceptedAt },
          currentAcceptedAt: isCurr ? acceptedAt : null,
        });
        return;
      }
      if (acceptedAt.getTime() > existing.latestOverall.acceptedAt.getTime()) {
        existing.latestOverall = { versionId, acceptedAt };
      }
      if (
        isCurr &&
        (existing.currentAcceptedAt === null ||
          acceptedAt.getTime() > existing.currentAcceptedAt.getTime())
      ) {
        existing.currentAcceptedAt = acceptedAt;
      }
    };

    const acctRows = await deps.db
      .select({
        documentId: policyAcceptances.documentId,
        versionId: policyAcceptances.policyVersionId,
        acceptedAt: policyAcceptances.acceptedAt,
      })
      .from(policyAcceptances)
      .where(eq(policyAcceptances.userId, user.id))
      .orderBy(desc(policyAcceptances.acceptedAt), desc(policyAcceptances.publicId));

    for (const r of acctRows) {
      const curr = catalog.currentVersionByDocId.get(r.documentId);
      recordDocAcceptance(r.documentId, r.versionId, r.acceptedAt, curr?.id);
    }

    const acc = acceptancePort();
    if (acc?.evidencePage) {
      let before: KeysetCursor | undefined;
      let more = true;
      while (more) {
        const gatePage = await acc.evidencePage({
          userIds: [user.id],
          before,
          limit: EVIDENCE_MAX_LIMIT,
        });
        for (const g of gatePage.items) {
          const curr = catalog.currentVersionByDocId.get(g.policyDocumentId);
          recordDocAcceptance(g.policyDocumentId, g.policyVersionId, g.acceptedAt, curr?.id);
        }
        const last = gatePage.items[gatePage.items.length - 1];
        if (gatePage.hasMore && last) {
          before = { acceptedAt: last.acceptedAt, publicId: last.publicId };
        } else {
          more = false;
        }
      }
    }

    const customerPolicies: CustomerPolicyStatusRow[] = [];
    for (const doc of catalog.docsById.values()) {
      if (!doc.active) continue;
      if (doc.audience !== "customer" && doc.audience !== "all") continue;
      const currentVer = catalog.currentVersionByDocId.get(doc.id);
      if (!currentVer) continue;

      const summary = acceptedVersionsByDoc.get(doc.id);
      let state: CustomerPolicyRequirementState;
      let chosenVersion: PolicyVersionRow | undefined;
      let chosenAcceptedAt: Date | null = null;

      if (summary?.currentAcceptedAt !== null && summary?.currentAcceptedAt !== undefined) {
        state = "accepted_current";
        chosenVersion = currentVer;
        chosenAcceptedAt = summary.currentAcceptedAt;
      } else if (!doc.requiresAcceptance) {
        state = "not_required";
        if (summary) {
          chosenVersion = catalog.versionsById.get(summary.latestOverall.versionId);
          chosenAcceptedAt = summary.latestOverall.acceptedAt;
        }
      } else if (summary) {
        state = "update_pending";
        chosenVersion = catalog.versionsById.get(summary.latestOverall.versionId);
        chosenAcceptedAt = summary.latestOverall.acceptedAt;
      } else {
        state = "not_accepted";
      }

      customerPolicies.push({
        documentPublicId: doc.publicId,
        slug: doc.slug,
        title: doc.title,
        requiresAcceptance: doc.requiresAcceptance,
        requiresTypedSignature: doc.requiresTypedSignature,
        currentVersionPublicId: currentVer.publicId,
        currentVersionNumber: currentVer.versionNumber,
        currentVersionLabel: currentVer.versionLabel,
        currentPublishedAt: currentVer.publishedAt,
        currentEffectiveAt: currentVer.effectiveAt,
        state,
        acceptedVersionPublicId: chosenVersion ? chosenVersion.publicId : null,
        acceptedVersionNumber: chosenVersion ? chosenVersion.versionNumber : null,
        acceptedVersionLabel: chosenVersion ? chosenVersion.versionLabel : null,
        acceptedAt: chosenAcceptedAt,
      });
    }

    const { items: history, hasMore } = await queryUnifiedStream(
      deps.db,
      principal,
      { customerPublicId: user.publicId },
      cursor,
      limit,
    );
    const last = history[history.length - 1];

    return {
      customer: {
        userPublicId: user.publicId,
        name: user.name,
        email: user.email,
        customerRef: user.customerRef,
      },
      policies: customerPolicies,
      history,
      nextCursor:
        hasMore && last
          ? encodeAcceptanceLogCursor({ acceptedAt: last.acceptedAt, publicId: last.publicId })
          : null,
    };
  }

  /* ------------------------------------------------------------------ 7. versionText */

  async function versionText(
    principal: SessionPrincipal,
    input: { versionPublicId: string },
  ): Promise<PolicyVersionReadView> {
    await authorizeRead(
      principal,
      "compliance.policies.admin.acceptanceLog.versionText",
      input.versionPublicId,
    );
    const now = deps.clock.now();
    const catalog = await loadCatalog(deps.db, now);

    const ver = catalog.versionsByPublicId.get(input.versionPublicId);
    if (!ver || ver.status !== "published") {
      throw notFound("POLICY_VERSION_NOT_FOUND");
    }
    const doc = catalog.docsById.get(ver.documentId);
    if (!doc) {
      throw notFound("POLICY_VERSION_NOT_FOUND");
    }
    const current = catalog.currentVersionByDocId.get(doc.id);

    return {
      documentPublicId: doc.publicId,
      policySlug: doc.slug,
      policyTitle: doc.title,
      audience: doc.audience,
      requiresAcceptance: doc.requiresAcceptance,
      requiresTypedSignature: doc.requiresTypedSignature,
      versionPublicId: ver.publicId,
      versionNumber: ver.versionNumber,
      versionLabel: ver.versionLabel,
      contentFormat: ver.contentFormat,
      bodyText: ver.bodyText,
      contentHash: ver.contentHash,
      shortContentHash: ver.contentHash.slice(0, 12),
      changeSummary: ver.changeSummary,
      effectiveAt: ver.effectiveAt,
      publishedAt: ver.publishedAt,
      isCurrent: current?.id === ver.id,
    };
  }

  /* ------------------------------------------------------------------ 8. export */

  function summarizeFilterKeys(input: AcceptanceLogFilterInput): string {
    const keys: string[] = [];
    if (input.customerQuery) keys.push("customer_query");
    if (input.customerPublicId) keys.push("customer");
    if (input.policyDocumentPublicId) keys.push("policy");
    if (input.versionPublicId) keys.push("version");
    if (input.from || input.to) keys.push("date_range");
    if (input.source) keys.push("source");
    if (input.method) keys.push("method");
    if (input.freshness) keys.push("freshness");
    if (input.orderReference) keys.push("order");
    return keys.length > 0 ? keys.join(",") : "none";
  }

  async function exportCsv(
    principal: SessionPrincipal,
    input: AcceptanceLogFilterInput = {},
  ): Promise<AcceptanceLogExportResult> {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) {
      throw new DomainError(
        "REMEDIATION_REQUIRED",
        "ACCOUNT_STEP_PENDING",
        "Please finish securing your account to continue.",
      );
    }

    // Customer gets NOT_FOUND on admin procedures (§4).
    if (principal.role === "customer") {
      await recordAuthzDenial(
        principal,
        "ADMIN_SURFACE_HIDDEN",
        "compliance.policies.admin.acceptanceLog.export",
      );
      throw notFound("NOT_FOUND");
    }

    if (!roleHasCapability(principal.role, "policies.acceptances.export")) {
      await recordAuthzDenial(
        principal,
        "CAPABILITY_NOT_GRANTED",
        "compliance.policies.admin.acceptanceLog.export",
      );
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }

    const now = deps.clock.now();
    if (!hasFreshStepUp(principal, now)) {
      deps.audit.note({
        category: "security",
        eventName: "authz.step_up.required",
        action: "authorize",
        outcome: "refused",
        severity: "INFO",
        reasonCode: "STEP_UP_REQUIRED",
        actor: { userId: principal.userId, role: principal.role },
        resource: { type: "policy_acceptance_log" },
        attributes: {
          procedure: "compliance.policies.admin.acceptanceLog.export",
          capability: "policies.acceptances.export",
        },
      });
      throw new DomainError(
        "STEP_UP_REQUIRED",
        "STEP_UP_REQUIRED",
        "Please confirm your password and authentication code to continue.",
        { capability: "policies.acceptances.export" },
      );
    }

    return runComplianceTx(
      deps,
      principal,
      { type: "policy_acceptance_log" },
      async (tx: Tx) => {
        // Re-check live role first so a demoted-to-customer session still receives NOT_FOUND.
        const [liveRoleRow] = await tx
          .select({ role: users.role })
          .from(users)
          .where(eq(users.id, principal.userId))
          .limit(1);
        if (liveRoleRow?.role === "customer") {
          throw notFound("NOT_FOUND");
        }

        const liveActor = await assertLiveActorInTx(
          deps,
          principal,
          tx,
          "policies.acceptances.export",
        );

        const { items, hasMore: truncated } = await queryUnifiedStream(
          tx,
          principal,
          input,
          undefined,
          MAX_ACCEPTANCE_EXPORT_ROWS,
        );

        const headerLine = `${ACCEPTANCE_CSV_COLUMNS.join(",")}\r\n`;
        const dataLines = items.map((item) => {
          // IMPORTANT: typedSignerName is NEVER included in CSV exports (Decision D4).
          const cells = [
            escapeAcceptanceCsvCell(item.publicId),
            escapeAcceptanceCsvCell(item.acceptedAt.toISOString()),
            escapeAcceptanceCsvCell(item.customer?.userPublicId ?? ""),
            escapeAcceptanceCsvCell(item.customer?.customerRef ?? ""),
            escapeAcceptanceCsvCell(item.customer?.name ?? ""),
            escapeAcceptanceCsvCell(item.customer?.email ?? ""),
            escapeAcceptanceCsvCell(item.policySlug),
            escapeAcceptanceCsvCell(item.policyTitle),
            escapeAcceptanceCsvCell(item.versionNumber),
            escapeAcceptanceCsvCell(item.versionLabel),
            escapeAcceptanceCsvCell(item.contentHash),
            escapeAcceptanceCsvCell(item.freshness),
            escapeAcceptanceCsvCell(item.source),
            escapeAcceptanceCsvCell(item.method),
            escapeAcceptanceCsvCell(item.orderReference ?? ""),
            escapeAcceptanceCsvCell(item.correlationId ?? ""),
          ];
          return `${cells.join(",")}\r\n`;
        });
        const csv = `${headerLine}${dataLines.join("")}`;

        const dateStamp = now.toISOString().slice(0, 10);
        const filename = `policy-acceptances-${dateStamp}.csv`;
        const filterSummary = summarizeFilterKeys(input);

        await deps.audit.record(
          {
            category: "admin",
            eventName: "policy.acceptance_log.exported",
            action: "export",
            outcome: "completed",
            actor: { userId: liveActor.userId, role: liveActor.role },
            resource: { type: "policy_acceptance_log" },
            safeCounts: { rows: items.length },
            attributes: {
              filter_summary: filterSummary,
              row_count: items.length,
              truncated,
              max_rows: MAX_ACCEPTANCE_EXPORT_ROWS,
              ...(input.policyDocumentPublicId
                ? { policy_document_public_id: input.policyDocumentPublicId }
                : {}),
              ...(input.versionPublicId ? { version_public_id: input.versionPublicId } : {}),
              ...(input.customerPublicId ? { customer_public_id: input.customerPublicId } : {}),
              ...(input.source ? { source: input.source } : {}),
              ...(input.method ? { method: input.method } : {}),
              ...(input.freshness ? { freshness: input.freshness } : {}),
            },
          },
          tx,
        );

        return {
          filename,
          contentType: "text/csv; charset=utf-8",
          csv,
          rowCount: items.length,
          truncated,
          maxRows: MAX_ACCEPTANCE_EXPORT_ROWS,
        };
      },
      {
        onRefusalAfterRollback: async (err) => {
          if (err.code === "NOT_FOUND" && err.reasonCode === "NOT_FOUND") {
            await recordAuthzDenial(
              principal,
              "ADMIN_SURFACE_HIDDEN",
              "compliance.policies.admin.acceptanceLog.export",
            );
          }
        },
      },
    );
  }

  return {
    filterOptions,
    list,
    detail,
    coverage,
    updates,
    forCustomer,
    versionText,
    export: exportCsv,
  };
}

export type AcceptanceLogService = ReturnType<typeof createAcceptanceLogService>;
