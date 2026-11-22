import { and, asc, count, desc, eq, inArray, lt, lte } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { getRequestContext } from "../../core/requestContext.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { users } from "../identity/schema.js";
import { assertLiveActorInTx, denyComplianceAuthz, runComplianceTx } from "./actorAuth.js";
import {
  decodeIdCursor,
  encodeIdCursor,
  hashPolicyContent,
  normalizePolicyBody,
  normalizeSignerComparison,
} from "./domain.js";
import {
  policyAcceptances,
  policyDocuments,
  policyVersions,
  type PolicyAcceptanceMethod,
  type PolicyAudience,
  type PolicyContentFormat,
  type PolicyVersionStatus,
} from "./schema.js";

export interface PublishedPolicyView {
  documentPublicId: string;
  slug: string;
  title: string;
  audience: PolicyAudience;
  requiresAcceptance: boolean;
  requiresTypedSignature: boolean;
  versionPublicId: string;
  versionNumber: number;
  versionLabel: string;
  contentFormat: PolicyContentFormat;
  bodyText: string;
  contentHash: string;
  changeSummary: string | null;
  effectiveAt: Date;
  publishedAt: Date;
}

export interface RequiredPolicySummary {
  documentPublicId: string;
  slug: string;
  title: string;
  audience: PolicyAudience;
  requiresTypedSignature: boolean;
  versionPublicId: string;
  versionNumber: number;
  versionLabel: string;
  contentFormat: PolicyContentFormat;
  bodyText: string;
  contentHash: string;
  effectiveAt: Date;
  publishedAt: Date;
}

export interface PolicyAcceptanceEvidenceView {
  acceptancePublicId: string;
  documentPublicId: string;
  slug: string;
  title: string;
  versionPublicId: string;
  versionNumber: number;
  versionLabel: string;
  versionContentHash: string;
  acceptedAt: Date;
  requestId: string;
  method: PolicyAcceptanceMethod;
  hasTypedSignature: boolean;
  orderPublicId: string | null;
  origin: "portal" | "import";
}

export interface PolicyVersionAdminView {
  versionPublicId: string;
  versionNumber: number;
  versionLabel: string;
  status: PolicyVersionStatus;
  contentFormat: PolicyContentFormat;
  bodyText: string;
  contentHash: string;
  changeSummary: string | null;
  effectiveAt: Date;
  publishedAt: Date | null;
  origin: "portal" | "import";
  createdAt: Date;
}

export interface PolicyDocumentAdminSummary {
  documentPublicId: string;
  slug: string;
  title: string;
  audience: PolicyAudience;
  requiresAcceptance: boolean;
  requiresTypedSignature: boolean;
  active: boolean;
  version: number;
  currentPublishedVersion: {
    versionPublicId: string;
    versionNumber: number;
    versionLabel: string;
    contentHash: string;
    effectiveAt: Date;
    publishedAt: Date | null;
  } | null;
  draftCount: number;
  publishedCount: number;
  updatedAt: Date;
}

export interface PolicyGateVersionView {
  id: number;
  publicId: string;
  versionNumber: number;
  versionLabel: string;
  contentFormat: PolicyContentFormat;
  bodyText: string;
  contentHash: string;
  effectiveAt: Date;
  publishedAt: Date | null;
}

export interface PolicyForGateView {
  documentId: number;
  documentPublicId: string;
  slug: string;
  title: string;
  audience: PolicyAudience;
  active: boolean;
  currentVersion: PolicyGateVersionView | null;
}

async function assertAdminPoliciesReadCapability(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  resource: { type: string; publicId?: string } = { type: "policy_document" },
): Promise<void> {
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    await denyComplianceAuthz(deps, principal, "REMEDIATION_SESSION", resource);
  }
  if (!roleHasCapability(principal.role, "policies.manage")) {
    await denyComplianceAuthz(deps, principal, "CAPABILITY_NOT_GRANTED", resource);
  }
}

function audienceAppliesToRole(audience: PolicyAudience, role: "customer" | "staff" | "admin"): boolean {
  if (audience === "all") return true;
  if (audience === "customer") return role === "customer";
  return role === "staff" || role === "admin";
}

export function createPoliciesService(deps: ModuleDeps) {
  async function loadActiveEffectivePublishedPolicies(
    dbOrTx: DbOrTx,
    now: Date,
    allowedAudiences?: readonly PolicyAudience[],
  ): Promise<
    Array<{
      doc: typeof policyDocuments.$inferSelect;
      ver: typeof policyVersions.$inferSelect;
    }>
  > {
    const docConds = [eq(policyDocuments.active, true)];
    if (allowedAudiences && allowedAudiences.length > 0) {
      docConds.push(inArray(policyDocuments.audience, [...allowedAudiences]));
    }
    const docs = await dbOrTx
      .select()
      .from(policyDocuments)
      .where(and(...docConds))
      .orderBy(asc(policyDocuments.slug));
    if (docs.length === 0) return [];

    const docIds = docs.map((d) => d.id);
    const versions = await dbOrTx
      .select()
      .from(policyVersions)
      .where(
        and(
          inArray(policyVersions.documentId, docIds),
          eq(policyVersions.status, "published"),
          eq(policyVersions.origin, "portal"),
          lte(policyVersions.effectiveAt, now),
        ),
      )
      .orderBy(desc(policyVersions.versionNumber), desc(policyVersions.id));

    const latestByDoc = new Map<number, typeof policyVersions.$inferSelect>();
    for (const ver of versions) {
      if (!latestByDoc.has(ver.documentId)) {
        latestByDoc.set(ver.documentId, ver);
      }
    }

    const out: Array<{
      doc: typeof policyDocuments.$inferSelect;
      ver: typeof policyVersions.$inferSelect;
    }> = [];
    for (const doc of docs) {
      const ver = latestByDoc.get(doc.id);
      if (ver) out.push({ doc, ver });
    }
    return out;
  }

  /**
   * Lists currently active, effective published policies.
   * When called without `callerRole` (the public `/legal` and `/register` endpoints),
   * `audience = "staff"` documents are excluded in SQL before selecting or serializing.
   */
  async function listPublished(opts?: {
    callerRole?: "customer" | "staff" | "admin";
  }): Promise<PublishedPolicyView[]> {
    const now = deps.clock.now();
    const allowedAudiences: readonly PolicyAudience[] =
      !opts?.callerRole || opts.callerRole === "customer"
        ? ["all", "customer"]
        : ["all", "staff"];
    const pairs = await loadActiveEffectivePublishedPolicies(deps.db, now, allowedAudiences);
    return pairs.map(({ doc, ver }) => ({
      documentPublicId: doc.publicId,
      slug: doc.slug,
      title: doc.title,
      audience: doc.audience,
      requiresAcceptance: doc.requiresAcceptance,
      requiresTypedSignature: doc.requiresTypedSignature,
      versionPublicId: ver.publicId,
      versionNumber: ver.versionNumber,
      versionLabel: ver.versionLabel,
      contentFormat: ver.contentFormat,
      bodyText: ver.bodyText,
      contentHash: ver.contentHash,
      changeSummary: ver.changeSummary,
      effectiveAt: ver.effectiveAt,
      publishedAt: ver.publishedAt ?? ver.effectiveAt,
    }));
  }

  async function resolveTargetRole(
    userId: number,
    explicitAudience: "customer" | "staff" | undefined,
    dbOrTx: DbOrTx,
  ): Promise<"customer" | "staff" | "admin"> {
    if (explicitAudience) return explicitAudience;
    const identitySvc = (deps.services as Partial<typeof deps.services>).identity;
    if (identitySvc && typeof identitySvc.getUser === "function") {
      const user = await identitySvc.getUser(userId, { tx: dbOrTx });
      if (user) return user.role;
    }
    const [row] = await dbOrTx.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    return row?.role ?? "customer";
  }

  async function requiredAcceptancesFor(
    userId: number,
    opts?: { audience?: "customer" | "staff"; tx?: DbOrTx },
  ): Promise<RequiredPolicySummary[]> {
    const dbOrTx = opts?.tx ?? deps.db;
    const now = deps.clock.now();
    const role = await resolveTargetRole(userId, opts?.audience, dbOrTx);
    const activePairs = await loadActiveEffectivePublishedPolicies(dbOrTx, now);

    const applicable = activePairs.filter(
      ({ doc }) => doc.requiresAcceptance && audienceAppliesToRole(doc.audience, role),
    );
    if (applicable.length === 0) return [];

    const versionIds = applicable.map(({ ver }) => ver.id);
    // Only portal-originated acceptances count as live consent on this installation;
    // imported historical acceptances remain read-only history with provenance (architecture §6.6).
    const acceptedRows = await dbOrTx
      .select({
        policyVersionId: policyAcceptances.policyVersionId,
        versionContentHash: policyAcceptances.versionContentHash,
      })
      .from(policyAcceptances)
      .where(
        and(
          eq(policyAcceptances.userId, userId),
          inArray(policyAcceptances.policyVersionId, versionIds),
          eq(policyAcceptances.origin, "portal"),
        ),
      );

    const acceptedHashesByVersion = new Map<number, string>();
    for (const row of acceptedRows) {
      acceptedHashesByVersion.set(row.policyVersionId, row.versionContentHash);
    }

    return applicable
      .filter(({ ver }) => acceptedHashesByVersion.get(ver.id) !== ver.contentHash)
      .map(({ doc, ver }) => ({
        documentPublicId: doc.publicId,
        slug: doc.slug,
        title: doc.title,
        audience: doc.audience,
        requiresTypedSignature: doc.requiresTypedSignature,
        versionPublicId: ver.publicId,
        versionNumber: ver.versionNumber,
        versionLabel: ver.versionLabel,
        contentFormat: ver.contentFormat,
        bodyText: ver.bodyText,
        contentHash: ver.contentHash,
        effectiveAt: ver.effectiveAt,
        publishedAt: ver.publishedAt ?? ver.effectiveAt,
      }));
  }

  async function assertRequiredPoliciesAccepted(
    userId: number,
    opts?: { audience?: "customer" | "staff"; tx?: DbOrTx },
  ): Promise<void> {
    const pending = await requiredAcceptancesFor(userId, opts);
    if (pending.length > 0) {
      throw new DomainError(
        "CONFLICT",
        "POLICY_ACCEPTANCE_REQUIRED",
        "Please review and accept the current required policies before continuing.",
        {
          pendingCount: pending.length,
          slugs: pending.map((p) => p.slug),
        },
      );
    }
  }

  async function myStatus(principal: SessionPrincipal): Promise<{
    published: PublishedPolicyView[];
    pendingRequired: RequiredPolicySummary[];
    acceptances: PolicyAcceptanceEvidenceView[];
  }> {
    const liveRole = await resolveTargetRole(principal.userId, undefined, deps.db);
    const [published, pendingRequired, rows] = await Promise.all([
      listPublished({ callerRole: liveRole }),
      requiredAcceptancesFor(principal.userId),
      deps.db
        .select({
          acceptance: policyAcceptances,
          doc: policyDocuments,
          ver: policyVersions,
        })
        .from(policyAcceptances)
        .innerJoin(policyDocuments, eq(policyAcceptances.documentId, policyDocuments.id))
        .innerJoin(policyVersions, eq(policyAcceptances.policyVersionId, policyVersions.id))
        .where(eq(policyAcceptances.userId, principal.userId))
        .orderBy(desc(policyAcceptances.acceptedAt), desc(policyAcceptances.id))
        .limit(100),
    ]);

    return {
      published: published.filter((p) => audienceAppliesToRole(p.audience, principal.role)),
      pendingRequired,
      acceptances: rows.map(({ acceptance, doc, ver }) => ({
        acceptancePublicId: acceptance.publicId,
        documentPublicId: doc.publicId,
        slug: doc.slug,
        title: doc.title,
        versionPublicId: ver.publicId,
        versionNumber: ver.versionNumber,
        versionLabel: ver.versionLabel,
        versionContentHash: acceptance.versionContentHash,
        acceptedAt: acceptance.acceptedAt,
        requestId: acceptance.requestId,
        method: acceptance.method,
        hasTypedSignature: acceptance.signerNameEnc !== null,
        orderPublicId: acceptance.orderPublicId,
        origin: acceptance.origin,
      })),
    };
  }

  async function acceptPolicyInTx(
    tx: Tx,
    input: {
      userId: number;
      actorRole: "customer" | "staff" | "admin";
      resolvedOrderId: number | null;
      resolvedOrderPublicId: string | null;
      versionPublicId: string;
      contentHash: string;
      flow: "portal" | "registration";
      signerName?: string | undefined;
    },
  ): Promise<{ acceptancePublicId: string; duplicate: boolean }> {
    const now = deps.clock.now();

    const [ver] = await tx
      .select()
      .from(policyVersions)
      .where(eq(policyVersions.publicId, input.versionPublicId))
      .for("share")
      .limit(1);

    if (!ver || ver.status !== "published" || ver.origin !== "portal") {
      throw notFound("POLICY_VERSION_NOT_FOUND");
    }

    // Lock the parent document FOR SHARE so concurrent deactivation, audience edits,
    // or publication of a superseding version are serialized against this acceptance.
    const [doc] = await tx
      .select()
      .from(policyDocuments)
      .where(eq(policyDocuments.id, ver.documentId))
      .for("share")
      .limit(1);

    if (!doc || !doc.active || !audienceAppliesToRole(doc.audience, input.actorRole)) {
      throw notFound("POLICY_VERSION_NOT_FOUND");
    }

    if (ver.effectiveAt.getTime() > now.getTime()) {
      throw notFound("POLICY_VERSION_NOT_FOUND");
    }

    const [currentEffective] = await tx
      .select({ id: policyVersions.id })
      .from(policyVersions)
      .where(
        and(
          eq(policyVersions.documentId, doc.id),
          eq(policyVersions.status, "published"),
          eq(policyVersions.origin, "portal"),
          lte(policyVersions.effectiveAt, now),
        ),
      )
      .orderBy(desc(policyVersions.versionNumber), desc(policyVersions.id))
      .for("share")
      .limit(1);

    if (!currentEffective || currentEffective.id !== ver.id) {
      throw conflict(
        "POLICY_VERSION_SUPERSEDED",
        "A newer version of this policy is now effective. Please reload and review the current version.",
      );
    }

    if (ver.contentHash !== input.contentHash) {
      throw conflict(
        "POLICY_HASH_MISMATCH",
        "The policy text changed since this page was loaded. Please reload and review the current version.",
      );
    }

    if (doc.requiresTypedSignature) {
      if (!input.signerName || input.signerName.trim().length < 2) {
        throw validation("TYPED_SIGNATURE_REQUIRED", "Please enter your full name to sign this policy.");
      }
      const identitySvc = (deps.services as Partial<typeof deps.services>).identity;
      const userView = identitySvc?.getUser ? await identitySvc.getUser(input.userId, { tx }) : null;
      if (userView && normalizeSignerComparison(userView.name) !== normalizeSignerComparison(input.signerName)) {
        throw validation(
          "SIGNER_NAME_MISMATCH",
          "The typed signature must match your account profile name.",
        );
      }
    }

    const [existing] = await tx
      .select()
      .from(policyAcceptances)
      .where(
        and(
          eq(policyAcceptances.userId, input.userId),
          eq(policyAcceptances.policyVersionId, ver.id),
          eq(policyAcceptances.origin, "portal"),
        ),
      )
      .for("update")
      .limit(1);

    if (existing) {
      return { acceptancePublicId: existing.publicId, duplicate: true };
    }

    const reqCtx = getRequestContext();
    const requestId = reqCtx?.requestId ?? ulid(now.getTime());
    const sourceAddressPseudonym = reqCtx?.ipAddress
      ? deps.crypto.pseudonym(reqCtx.ipAddress, "compliance.policy_acceptance.ip")
      : null;

    const acceptancePublicId = ulid(now.getTime());
    // Derive method strictly on the server; never trust client-supplied method claims.
    const effectiveMethod: PolicyAcceptanceMethod = doc.requiresTypedSignature
      ? "typed_signature"
      : input.flow === "registration"
        ? "registration"
        : "portal_checkbox";
    const signerNameEnc =
      doc.requiresTypedSignature && input.signerName
        ? deps.crypto.encrypt(input.signerName.trim(), `policy_acceptances.signer_name:${acceptancePublicId}`)
        : null;

    await tx.insert(policyAcceptances).values({
      publicId: acceptancePublicId,
      userId: input.userId,
      documentId: doc.id,
      policyVersionId: ver.id,
      versionContentHash: ver.contentHash,
      acceptedAt: now,
      requestId,
      sourceAddressPseudonym,
      method: effectiveMethod,
      signerNameEnc,
      orderId: input.resolvedOrderId,
      orderPublicId: input.resolvedOrderPublicId,
      origin: "portal",
      createdAt: now,
    });

    await deps.audit.record(
      {
        category: "business",
        eventName: "policy.accepted",
        action: "accept",
        outcome: "completed",
        actor: { userId: input.userId, role: input.actorRole },
        resource: { type: "policy_acceptance", publicId: acceptancePublicId },
        attributes: {
          document_public_id: doc.publicId,
          version_public_id: ver.publicId,
          content_hash: ver.contentHash,
          method: effectiveMethod,
          has_order_binding: input.resolvedOrderPublicId !== null,
        },
      },
      tx,
    );

    return { acceptancePublicId, duplicate: false };
  }

  async function accept(
    principal: SessionPrincipal,
    input: {
      versionPublicId: string;
      contentHash: string;
      method?: "portal_checkbox" | "typed_signature" | undefined;
      signerName?: string | undefined;
      orderPublicId?: string | undefined;
    },
  ): Promise<{ acceptancePublicId: string; duplicate: boolean }> {
    return runComplianceTx(deps, principal, { type: "policy_version", publicId: input.versionPublicId }, async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx);
      const livePrincipal: SessionPrincipal = { ...principal, role: liveActor.role };
      let resolvedOrderId: number | null = null;
      let resolvedOrderPublicId: string | null = null;
      if (input.orderPublicId) {
        const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
        if (!ordersSvc) {
          throw new DomainError("UNAVAILABLE", "ORDERS_UNAVAILABLE", "Order verification is temporarily unavailable.");
        }
        const orderView = await ordersSvc.assertCanReadOrder(livePrincipal, input.orderPublicId, { tx });
        resolvedOrderId = orderView.id;
        resolvedOrderPublicId = orderView.publicId;
      }
      return acceptPolicyInTx(tx, {
        userId: liveActor.userId,
        actorRole: liveActor.role,
        resolvedOrderId,
        resolvedOrderPublicId,
        versionPublicId: input.versionPublicId,
        contentHash: input.contentHash,
        flow: "portal",
        signerName: input.signerName,
      });
    });
  }

  async function recordRegistrationAcceptances(
    input: {
      userId: number;
      items: readonly { versionPublicId: string; contentHash: string; signerName?: string }[];
    },
    opts?: { tx?: Tx },
  ): Promise<{ recorded: number }> {
    const run = async (tx: Tx) => {
      let recorded = 0;
      for (const item of input.items) {
        const res = await acceptPolicyInTx(tx, {
          userId: input.userId,
          actorRole: "customer",
          resolvedOrderId: null,
          resolvedOrderPublicId: null,
          versionPublicId: item.versionPublicId,
          contentHash: item.contentHash,
          flow: "registration",
          signerName: item.signerName,
        });
        if (!res.duplicate) recorded += 1;
      }
      return { recorded };
    };
    if (opts?.tx) return run(opts.tx);
    return deps.db.transaction(run);
  }

  async function recordCheckoutAcceptances(
    input: {
      principal: SessionPrincipal;
      orderId?: number | undefined;
      orderPublicId?: string | undefined;
      items: readonly { versionPublicId: string; contentHash: string; signerName?: string | undefined }[];
    },
    tx: Tx,
  ): Promise<{ recorded: number }> {
    const liveActor = await assertLiveActorInTx(deps, input.principal, tx);
    const livePrincipal: SessionPrincipal = { ...input.principal, role: liveActor.role };
    let resolvedOrderId: number | null = input.orderId ?? null;
    let resolvedOrderPublicId: string | null = input.orderPublicId ?? null;
    if (input.orderPublicId) {
      const ordersSvc = (deps.services as Partial<typeof deps.services>).orders;
      if (!ordersSvc) {
        throw new DomainError("UNAVAILABLE", "ORDERS_UNAVAILABLE", "Order verification is temporarily unavailable.");
      }
      const orderView = await ordersSvc.assertCanReadOrder(livePrincipal, input.orderPublicId, { tx });
      resolvedOrderId = orderView.id;
      resolvedOrderPublicId = orderView.publicId;
    }
    let recorded = 0;
    for (const item of input.items) {
      const res = await acceptPolicyInTx(tx, {
        userId: liveActor.userId,
        actorRole: liveActor.role,
        resolvedOrderId,
        resolvedOrderPublicId,
        versionPublicId: item.versionPublicId,
        contentHash: item.contentHash,
        flow: "portal",
        signerName: item.signerName,
      });
      if (!res.duplicate) recorded += 1;
    }
    return { recorded };
  }


  /* --------------------------------------------------------- admin authoring */

  async function adminListDocuments(principal: SessionPrincipal): Promise<PolicyDocumentAdminSummary[]> {
    await assertAdminPoliciesReadCapability(deps, principal, { type: "policy_document" });
    const docs = await deps.db.select().from(policyDocuments).orderBy(asc(policyDocuments.slug));
    if (docs.length === 0) return [];

    const docIds = docs.map((d) => d.id);
    const versions = await deps.db
      .select()
      .from(policyVersions)
      .where(inArray(policyVersions.documentId, docIds))
      .orderBy(desc(policyVersions.versionNumber));

    const versionsByDoc = new Map<number, (typeof policyVersions.$inferSelect)[]>();
    for (const ver of versions) {
      const list = versionsByDoc.get(ver.documentId) ?? [];
      list.push(ver);
      versionsByDoc.set(ver.documentId, list);
    }

    return docs.map((doc) => {
      const docVersions = versionsByDoc.get(doc.id) ?? [];
      const currentPub =
        docVersions.find((v) => v.id === doc.currentPublishedVersionId) ??
        docVersions.find((v) => v.status === "published" && v.origin === "portal") ??
        null;
      return {
        documentPublicId: doc.publicId,
        slug: doc.slug,
        title: doc.title,
        audience: doc.audience,
        requiresAcceptance: doc.requiresAcceptance,
        requiresTypedSignature: doc.requiresTypedSignature,
        active: doc.active,
        version: doc.version,
        currentPublishedVersion: currentPub
          ? {
              versionPublicId: currentPub.publicId,
              versionNumber: currentPub.versionNumber,
              versionLabel: currentPub.versionLabel,
              contentHash: currentPub.contentHash,
              effectiveAt: currentPub.effectiveAt,
              publishedAt: currentPub.publishedAt,
            }
          : null,
        draftCount: docVersions.filter((v) => v.status === "draft").length,
        publishedCount: docVersions.filter((v) => v.status === "published").length,
        updatedAt: doc.updatedAt,
      };
    });
  }

  async function adminGetDocument(
    principal: SessionPrincipal,
    documentPublicId: string,
  ): Promise<{
    document: Omit<PolicyDocumentAdminSummary, "draftCount" | "publishedCount" | "currentPublishedVersion">;
    versions: PolicyVersionAdminView[];
  }> {
    await assertAdminPoliciesReadCapability(deps, principal, { type: "policy_document", publicId: documentPublicId });
    const [doc] = await deps.db
      .select()
      .from(policyDocuments)
      .where(eq(policyDocuments.publicId, documentPublicId))
      .limit(1);
    if (!doc) throw notFound("POLICY_DOCUMENT_NOT_FOUND");

    const versions = await deps.db
      .select()
      .from(policyVersions)
      .where(eq(policyVersions.documentId, doc.id))
      .orderBy(desc(policyVersions.versionNumber));

    return {
      document: {
        documentPublicId: doc.publicId,
        slug: doc.slug,
        title: doc.title,
        audience: doc.audience,
        requiresAcceptance: doc.requiresAcceptance,
        requiresTypedSignature: doc.requiresTypedSignature,
        active: doc.active,
        version: doc.version,
        updatedAt: doc.updatedAt,
      },
      versions: versions.map((v) => ({
        versionPublicId: v.publicId,
        versionNumber: v.versionNumber,
        versionLabel: v.versionLabel,
        status: v.status,
        contentFormat: v.contentFormat,
        bodyText: v.bodyText,
        contentHash: v.contentHash,
        changeSummary: v.changeSummary,
        effectiveAt: v.effectiveAt,
        publishedAt: v.publishedAt,
        origin: v.origin,
        createdAt: v.createdAt,
      })),
    };
  }

  async function adminCreateDocument(
    principal: SessionPrincipal,
    input: {
      slug: string;
      title: string;
      audience: PolicyAudience;
      requiresAcceptance: boolean;
      requiresTypedSignature: boolean;
      versionLabel: string;
      contentFormat: PolicyContentFormat;
      bodyText: string;
      changeSummary?: string | undefined;
      effectiveAt?: Date | undefined;
    },
  ): Promise<{ documentPublicId: string; draftVersionPublicId: string; contentHash: string }> {
    const now = deps.clock.now();
    const normalizedBody = normalizePolicyBody(input.bodyText);
    const contentHash = hashPolicyContent(normalizedBody);
    const effectiveAt = input.effectiveAt ?? now;

    return runComplianceTx(deps, principal, { type: "policy_document" }, async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "policies.manage");

      const [existing] = await tx
        .select({ id: policyDocuments.id })
        .from(policyDocuments)
        .where(eq(policyDocuments.slug, input.slug))
        .for("update")
        .limit(1);
      if (existing) {
        throw conflict("POLICY_SLUG_IN_USE", "A policy document with that slug already exists.");
      }

      const documentPublicId = ulid(now.getTime());
      const [docIns] = await tx.insert(policyDocuments).values({
        publicId: documentPublicId,
        slug: input.slug,
        title: input.title,
        audience: input.audience,
        requiresAcceptance: input.requiresAcceptance,
        requiresTypedSignature: input.requiresTypedSignature,
        active: true,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });

      const draftVersionPublicId = ulid(now.getTime());
      await tx.insert(policyVersions).values({
        publicId: draftVersionPublicId,
        documentId: docIns.insertId,
        versionNumber: 1,
        versionLabel: input.versionLabel,
        status: "draft",
        contentFormat: input.contentFormat,
        bodyText: normalizedBody,
        contentHash,
        changeSummary: input.changeSummary ?? null,
        effectiveAt,
        origin: "portal",
        createdAt: now,
        updatedAt: now,
      });

      await deps.audit.record(
        {
          category: "admin",
          eventName: "policy.document.created",
          action: "create",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "policy_document", publicId: documentPublicId },
          attributes: {
            slug: input.slug,
            audience: input.audience,
            requires_acceptance: input.requiresAcceptance,
            draft_version_public_id: draftVersionPublicId,
          },
        },
        tx,
      );

      return { documentPublicId, draftVersionPublicId, contentHash };
    });
  }

  async function adminUpdateDocument(
    principal: SessionPrincipal,
    input: {
      documentPublicId: string;
      expectedVersion: number;
      title: string;
      audience: PolicyAudience;
      requiresAcceptance: boolean;
      requiresTypedSignature: boolean;
      active: boolean;
    },
  ): Promise<{ documentPublicId: string; version: number }> {
    const now = deps.clock.now();

    return runComplianceTx(deps, principal, { type: "policy_document", publicId: input.documentPublicId }, async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "policies.manage");

      const [doc] = await tx
        .select()
        .from(policyDocuments)
        .where(eq(policyDocuments.publicId, input.documentPublicId))
        .for("update")
        .limit(1);
      if (!doc) throw notFound("POLICY_DOCUMENT_NOT_FOUND");
      if (doc.version !== input.expectedVersion) {
        throw conflict("VERSION_MISMATCH", "This policy document was updated by another administrator. Reload and try again.");
      }

      const nextVersion = doc.version + 1;
      await tx
        .update(policyDocuments)
        .set({
          title: input.title,
          audience: input.audience,
          requiresAcceptance: input.requiresAcceptance,
          requiresTypedSignature: input.requiresTypedSignature,
          active: input.active,
          version: nextVersion,
          updatedAt: now,
        })
        .where(eq(policyDocuments.id, doc.id));

      await deps.audit.record(
        {
          category: "admin",
          eventName: "policy.document.updated",
          action: "update",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "policy_document", publicId: doc.publicId },
          attributes: {
            audience: input.audience,
            requires_acceptance: input.requiresAcceptance,
            requires_typed_signature: input.requiresTypedSignature,
            active: input.active,
          },
        },
        tx,
      );

      return { documentPublicId: doc.publicId, version: nextVersion };
    });
  }

  async function adminCreateDraftVersion(
    principal: SessionPrincipal,
    input: {
      documentPublicId: string;
      versionLabel: string;
      contentFormat: PolicyContentFormat;
      bodyText: string;
      changeSummary?: string | undefined;
      effectiveAt?: Date | undefined;
    },
  ): Promise<{ versionPublicId: string; versionNumber: number; contentHash: string }> {
    const now = deps.clock.now();
    const normalizedBody = normalizePolicyBody(input.bodyText);
    const contentHash = hashPolicyContent(normalizedBody);

    return runComplianceTx(deps, principal, { type: "policy_document", publicId: input.documentPublicId }, async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "policies.manage");

      const [doc] = await tx
        .select()
        .from(policyDocuments)
        .where(eq(policyDocuments.publicId, input.documentPublicId))
        .for("update")
        .limit(1);
      if (!doc) throw notFound("POLICY_DOCUMENT_NOT_FOUND");

      const existingVersions = await tx
        .select({ versionNumber: policyVersions.versionNumber, versionLabel: policyVersions.versionLabel })
        .from(policyVersions)
        .where(eq(policyVersions.documentId, doc.id))
        .orderBy(desc(policyVersions.versionNumber));

      if (existingVersions.some((v) => v.versionLabel === input.versionLabel)) {
        throw conflict("POLICY_VERSION_LABEL_IN_USE", "That version label is already used on this policy document.");
      }

      const nextNum = (existingVersions[0]?.versionNumber ?? 0) + 1;
      const versionPublicId = ulid(now.getTime());

      await tx.insert(policyVersions).values({
        publicId: versionPublicId,
        documentId: doc.id,
        versionNumber: nextNum,
        versionLabel: input.versionLabel,
        status: "draft",
        contentFormat: input.contentFormat,
        bodyText: normalizedBody,
        contentHash,
        changeSummary: input.changeSummary ?? null,
        effectiveAt: input.effectiveAt ?? now,
        origin: "portal",
        createdAt: now,
        updatedAt: now,
      });

      await deps.audit.record(
        {
          category: "admin",
          eventName: "policy.version.draft_saved",
          action: "create",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "policy_version", publicId: versionPublicId },
          attributes: {
            document_public_id: doc.publicId,
            version_number: nextNum,
            content_hash: contentHash,
          },
        },
        tx,
      );

      return { versionPublicId, versionNumber: nextNum, contentHash };
    });
  }

  async function adminUpdateDraftVersion(
    principal: SessionPrincipal,
    input: {
      versionPublicId: string;
      versionLabel: string;
      contentFormat: PolicyContentFormat;
      bodyText: string;
      changeSummary?: string | undefined;
      effectiveAt: Date;
    },
  ): Promise<{ versionPublicId: string; contentHash: string }> {
    const now = deps.clock.now();
    const normalizedBody = normalizePolicyBody(input.bodyText);
    const contentHash = hashPolicyContent(normalizedBody);

    return runComplianceTx(deps, principal, { type: "policy_version", publicId: input.versionPublicId }, async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "policies.manage");

      const [ver] = await tx
        .select()
        .from(policyVersions)
        .where(eq(policyVersions.publicId, input.versionPublicId))
        .for("update")
        .limit(1);
      if (!ver) throw notFound("POLICY_VERSION_NOT_FOUND");
      if (ver.status !== "draft") {
        throw conflict("POLICY_VERSION_IMMUTABLE", "Published policy versions cannot be modified.");
      }

      const siblings = await tx
        .select({ id: policyVersions.id, versionLabel: policyVersions.versionLabel })
        .from(policyVersions)
        .where(eq(policyVersions.documentId, ver.documentId));
      if (siblings.some((s) => s.id !== ver.id && s.versionLabel === input.versionLabel)) {
        throw conflict("POLICY_VERSION_LABEL_IN_USE", "That version label is already used on this policy document.");
      }

      await tx
        .update(policyVersions)
        .set({
          versionLabel: input.versionLabel,
          contentFormat: input.contentFormat,
          bodyText: normalizedBody,
          contentHash,
          changeSummary: input.changeSummary ?? null,
          effectiveAt: input.effectiveAt,
          updatedAt: now,
        })
        .where(eq(policyVersions.id, ver.id));

      await deps.audit.record(
        {
          category: "admin",
          eventName: "policy.version.draft_saved",
          action: "update",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "policy_version", publicId: ver.publicId },
          attributes: {
            version_number: ver.versionNumber,
            content_hash: contentHash,
          },
        },
        tx,
      );

      return { versionPublicId: ver.publicId, contentHash };
    });
  }

  async function adminDeleteDraftVersion(
    principal: SessionPrincipal,
    versionPublicId: string,
  ): Promise<{ deleted: true }> {
    return runComplianceTx(deps, principal, { type: "policy_version", publicId: versionPublicId }, async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "policies.manage");

      // Re-check status under row lock and record durable audit BEFORE deletion.
      const [ver] = await tx
        .select()
        .from(policyVersions)
        .where(eq(policyVersions.publicId, versionPublicId))
        .for("update")
        .limit(1);
      if (!ver) throw notFound("POLICY_VERSION_NOT_FOUND");
      if (ver.status !== "draft") {
        throw conflict("POLICY_VERSION_IMMUTABLE", "Published policy versions cannot be deleted.");
      }

      await deps.audit.record(
        {
          category: "admin",
          eventName: "policy.version.draft_deleted",
          action: "delete",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "policy_version", publicId: ver.publicId },
          attributes: { version_number: ver.versionNumber },
        },
        tx,
      );

      await tx.delete(policyVersions).where(eq(policyVersions.id, ver.id));

      return { deleted: true };
    });
  }

  async function adminPublishVersion(
    principal: SessionPrincipal,
    input: { versionPublicId: string; effectiveAt?: Date | undefined },
  ): Promise<{ versionPublicId: string; contentHash: string; publishedAt: Date; effectiveAt: Date }> {
    const now = deps.clock.now();

    return runComplianceTx(deps, principal, { type: "policy_version", publicId: input.versionPublicId }, async (tx) => {
      const liveActor = await assertLiveActorInTx(deps, principal, tx, "policies.manage");

      const [ver] = await tx
        .select()
        .from(policyVersions)
        .where(eq(policyVersions.publicId, input.versionPublicId))
        .for("update")
        .limit(1);
      if (!ver) throw notFound("POLICY_VERSION_NOT_FOUND");
      if (ver.status === "published") {
        throw conflict("POLICY_VERSION_IMMUTABLE", "This policy version is already published.");
      }

      const [doc] = await tx
        .select()
        .from(policyDocuments)
        .where(eq(policyDocuments.id, ver.documentId))
        .for("update")
        .limit(1);
      if (!doc) throw notFound("POLICY_DOCUMENT_NOT_FOUND");

      const normalizedBody = normalizePolicyBody(ver.bodyText);
      const lockedHash = hashPolicyContent(normalizedBody);
      const effectiveAt = input.effectiveAt ?? ver.effectiveAt;

      await tx
        .update(policyVersions)
        .set({
          status: "published",
          bodyText: normalizedBody,
          contentHash: lockedHash,
          effectiveAt,
          publishedAt: now,
          publishedByUserId: liveActor.userId,
          updatedAt: now,
        })
        .where(eq(policyVersions.id, ver.id));

      await tx
        .update(policyDocuments)
        .set({
          currentPublishedVersionId: ver.id,
          version: doc.version + 1,
          updatedAt: now,
        })
        .where(eq(policyDocuments.id, doc.id));

      await deps.audit.record(
        {
          category: "admin",
          eventName: "policy.version.published",
          action: "transition",
          outcome: "completed",
          actor: { userId: liveActor.userId, role: liveActor.role },
          resource: { type: "policy_version", publicId: ver.publicId },
          attributes: {
            document_public_id: doc.publicId,
            slug: doc.slug,
            version_number: ver.versionNumber,
            content_hash: lockedHash,
            requires_acceptance: doc.requiresAcceptance,
          },
        },
        tx,
      );

      return { versionPublicId: ver.publicId, contentHash: lockedHash, publishedAt: now, effectiveAt };
    });
  }

  async function adminListAcceptances(
    principal: SessionPrincipal,
    input: {
      documentPublicId?: string | undefined;
      versionPublicId?: string | undefined;
      userPublicId?: string | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<{
    items: Array<
      PolicyAcceptanceEvidenceView & {
        userPublicId: string;
        sourceAddressPseudonym: string | null;
      }
    >;
    nextCursor: string | null;
  }> {
    await assertAdminPoliciesReadCapability(deps, principal, { type: "policy_acceptance" });
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const afterId = decodeIdCursor(input.cursor);

    const conditions = [];
    if (afterId !== null) {
      conditions.push(lt(policyAcceptances.id, afterId));
    }
    if (input.documentPublicId) {
      const [doc] = await deps.db
        .select({ id: policyDocuments.id })
        .from(policyDocuments)
        .where(eq(policyDocuments.publicId, input.documentPublicId))
        .limit(1);
      if (!doc) return { items: [], nextCursor: null };
      conditions.push(eq(policyAcceptances.documentId, doc.id));
    }
    if (input.versionPublicId) {
      const [ver] = await deps.db
        .select({ id: policyVersions.id })
        .from(policyVersions)
        .where(eq(policyVersions.publicId, input.versionPublicId))
        .limit(1);
      if (!ver) return { items: [], nextCursor: null };
      conditions.push(eq(policyAcceptances.policyVersionId, ver.id));
    }
    if (input.userPublicId) {
      const [usr] = await deps.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.publicId, input.userPublicId))
        .limit(1);
      if (!usr) return { items: [], nextCursor: null };
      conditions.push(eq(policyAcceptances.userId, usr.id));
    }

    const rows = await deps.db
      .select({
        acceptance: policyAcceptances,
        doc: policyDocuments,
        ver: policyVersions,
        userPublicId: users.publicId,
      })
      .from(policyAcceptances)
      .innerJoin(policyDocuments, eq(policyAcceptances.documentId, policyDocuments.id))
      .innerJoin(policyVersions, eq(policyAcceptances.policyVersionId, policyVersions.id))
      .innerJoin(users, eq(policyAcceptances.userId, users.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(policyAcceptances.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const last = slice[slice.length - 1];

    return {
      items: slice.map(({ acceptance, doc, ver, userPublicId }) => ({
        acceptancePublicId: acceptance.publicId,
        userPublicId,
        documentPublicId: doc.publicId,
        slug: doc.slug,
        title: doc.title,
        versionPublicId: ver.publicId,
        versionNumber: ver.versionNumber,
        versionLabel: ver.versionLabel,
        versionContentHash: acceptance.versionContentHash,
        acceptedAt: acceptance.acceptedAt,
        requestId: acceptance.requestId,
        sourceAddressPseudonym: acceptance.sourceAddressPseudonym,
        method: acceptance.method,
        hasTypedSignature: acceptance.signerNameEnc !== null,
        orderPublicId: acceptance.orderPublicId,
        origin: acceptance.origin,
      })),
      nextCursor: hasMore && last ? encodeIdCursor(last.acceptance.id) : null,
    };
  }

  async function versionForGate(
    policyPublicId: string,
    tx?: DbOrTx,
  ): Promise<PolicyForGateView | null> {
    const dbOrTx = tx ?? deps.db;
    const [doc] = await dbOrTx
      .select()
      .from(policyDocuments)
      .where(eq(policyDocuments.publicId, policyPublicId))
      .limit(1);
    if (!doc) return null;
    if (!doc.active) {
      return {
        documentId: doc.id,
        documentPublicId: doc.publicId,
        slug: doc.slug,
        title: doc.title,
        audience: doc.audience,
        active: false,
        currentVersion: null,
      };
    }
    const [ver] = await dbOrTx
      .select()
      .from(policyVersions)
      .where(
        and(
          eq(policyVersions.documentId, doc.id),
          eq(policyVersions.status, "published"),
          eq(policyVersions.origin, "portal"),
          lte(policyVersions.effectiveAt, deps.clock.now()),
        ),
      )
      .orderBy(desc(policyVersions.versionNumber), desc(policyVersions.id))
      .limit(1);
    return {
      documentId: doc.id,
      documentPublicId: doc.publicId,
      slug: doc.slug,
      title: doc.title,
      audience: doc.audience,
      active: doc.active,
      currentVersion: ver
        ? {
            id: ver.id,
            publicId: ver.publicId,
            versionNumber: ver.versionNumber,
            versionLabel: ver.versionLabel,
            contentFormat: ver.contentFormat,
            bodyText: ver.bodyText,
            contentHash: ver.contentHash,
            effectiveAt: ver.effectiveAt,
            publishedAt: ver.publishedAt,
          }
        : null,
    };
  }

  async function versionById(
    versionId: number,
    tx?: DbOrTx,
  ): Promise<PolicyForGateView | null> {
    const dbOrTx = tx ?? deps.db;
    const [ver] = await dbOrTx
      .select()
      .from(policyVersions)
      .where(eq(policyVersions.id, versionId))
      .limit(1);
    if (!ver) return null;
    const [doc] = await dbOrTx
      .select()
      .from(policyDocuments)
      .where(eq(policyDocuments.id, ver.documentId))
      .limit(1);
    if (!doc) return null;
    return {
      documentId: doc.id,
      documentPublicId: doc.publicId,
      slug: doc.slug,
      title: doc.title,
      audience: doc.audience,
      active: doc.active,
      currentVersion: {
        id: ver.id,
        publicId: ver.publicId,
        versionNumber: ver.versionNumber,
        versionLabel: ver.versionLabel,
        contentFormat: ver.contentFormat,
        bodyText: ver.bodyText,
        contentHash: ver.contentHash,
        effectiveAt: ver.effectiveAt,
        publishedAt: ver.publishedAt,
      },
    };
  }

  async function healthCounts(): Promise<{ publishedDocuments: number; requiredDocuments: number }> {
    const [pubRow] = await deps.db
      .select({ total: count() })
      .from(policyDocuments)
      .where(and(eq(policyDocuments.active, true)));
    const activePairs = await loadActiveEffectivePublishedPolicies(deps.db, deps.clock.now());
    return {
      publishedDocuments: activePairs.length,
      requiredDocuments: activePairs.filter(({ doc }) => doc.requiresAcceptance && pubRow !== undefined).length,
    };
  }

  return {
    listPublished,
    requiredAcceptancesFor,
    assertRequiredPoliciesAccepted,
    myStatus,
    accept,
    recordRegistrationAcceptances,
    recordCheckoutAcceptances,
    versionForGate,
    versionById,
    admin: {
      listDocuments: adminListDocuments,
      getDocument: adminGetDocument,
      createDocument: adminCreateDocument,
      updateDocument: adminUpdateDocument,
      createDraftVersion: adminCreateDraftVersion,
      updateDraftVersion: adminUpdateDraftVersion,
      deleteDraftVersion: adminDeleteDraftVersion,
      publishVersion: adminPublishVersion,
      listAcceptances: adminListAcceptances,
    },
    healthCounts,
  };
}

export type PoliciesService = ReturnType<typeof createPoliciesService>;
