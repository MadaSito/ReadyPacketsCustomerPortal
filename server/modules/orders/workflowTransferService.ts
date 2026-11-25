/**
 * Increment 05 (A1, contract D1 / ADR 0042) — workflow export and import (server).
 *
 * - Export: administrators with `workflows.export`; one, a selection or all workflows; the current PUBLISHED
 *   version with its canvas layout, or the latest draft (flagged `unpublished`) for a workflow never published.
 *   Gates point to package references (policy slug, title, audience), never local ids. No order or customer data,
 *   no user ids, no numeric ids, no secrets. Audit `workflow.exported`.
 * - Import: two stateless steps over the same untrusted text (`workflowTransfer.ts` parses it). `preview` returns
 *   the plan (audit `workflow.import_previewed`); `applyImport` re-validates everything, requires an idempotency
 *   key and fresh step-up, and only ever creates DRAFTS (nothing is published, no default changes, no order is
 *   touched). Audit `workflow.imported`. A replay with the same key and the same request returns the first
 *   result; a different request under the same key is refused (IDEMPOTENCY_KEY_REUSED).
 * - Setting `orders.workflow_transfer.enabled`: ON by default since increment 06 (D10). When off, administrators
 *   with `workflows.manage` turn it back on from the Workflows page (`setEnabled`, audited).
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { roleHasCapability } from "../../../shared/capabilities.js";
import { conflict, DomainError, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { AuditEmitter, Clock, Db, DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import type { Services } from "../../container.js";
import type { ActorCheck } from "./actor.js";
import { orderWorkflowDrafts, orderWorkflowImports, orderWorkflows, orderWorkflowVersionLayouts, orderWorkflowVersions } from "./schema.js";
import { draftDefinitionSchema, layoutSchema, pruneLayout, toDraft, type WorkflowDraftDefinition, type WorkflowLayout } from "./workflowDesign.js";
import { workflowDefinitionSchema } from "./workflowTypes.js";
import {
  analysePackage,
  auditSafe,
  canonicalJson,
  exportFileName,
  packageDigest,
  parsePackage,
  sha256Hex,
  toDraftDefinition,
  TRANSFER_FORMAT,
  transferFormatVersionFor,
  TRANSFER_MAX_BYTES,
  TRANSFER_MAX_WORKFLOWS,
  uniqueKey,
  workflowFindings,
  type GateResolution,
  type PackageDefinition,
  type PackagePolicy,
  type ParsedPackage,
  type TransferBlocking,
  type TransferFinding,
} from "./workflowTransfer.js";

export interface WorkflowTransferDeps {
  db: Db;
  clock: Clock;
  audit: AuditEmitter;
  services: Services;
  actorCheck: ActorCheck;
  /** `orders.workflow_transfer.enabled`. */
  enabled: (tx?: Tx) => Promise<boolean>;
  /** Writes `orders.workflow_transfer.enabled` inside `tx` (the settings store audits the change too). */
  writeEnabled: (value: boolean, tx: Tx) => Promise<void>;
  /** `orders.workflow_rules.enabled` (only for the RULES_DISABLED warning). */
  rulesEnabled: (tx?: Tx) => Promise<boolean>;
  release: string;
  installationLabel: string;
}

export type TransferAction = "create" | "draft" | "skip";
export type TransferSelection = { all: true } | { workflowKeys: string[] };

export interface TransferStatus {
  enabled: boolean;
  /** Increment 06 (D10): may this administrator switch the feature on or off from the Workflows page? */
  canToggle: boolean;
  canExport: boolean;
  canImport: boolean;
  maxBytes: number;
  maxWorkflows: number;
}

export interface TransferPreview {
  digest: string;
  formatVersion: number;
  exportedAt: string;
  source: { release: string; label: string };
  blocking: TransferBlocking[];
  workflows: {
    key: string;
    name: string;
    unpublished: boolean;
    valid: boolean;
    findings: TransferFinding[];
    existing: { workflowPublicId: string | null; name: string; hasDraft: boolean } | null;
    suggestedKey: string;
  }[];
  references: {
    policies: {
      ref: string;
      slug: string;
      title: string;
      audience: string;
      usedBy: string[];
      resolution: { status: "matched"; localPolicyPublicId: string; title: string } | { status: "not_found" };
    }[];
  };
}

export interface TransferApplyInput {
  packageText: string;
  idempotencyKey: string;
  decisions: { key: string; action: TransferAction }[];
  policyMappings: { ref: string; localPolicyPublicId?: string; removeGates?: true }[];
}
export interface TransferApplyResult {
  importPublicId: string;
  replayed: boolean;
  results: { key: string; action: TransferAction; workflowKey: string | null; draftPublicId: string | null }[];
}

interface LocalPolicy {
  documentPublicId: string;
  slug: string;
  title: string;
  audience: string;
}

const DISABLED = () => new DomainError("FORBIDDEN", "WORKFLOW_TRANSFER_DISABLED", "Workflow export and import are switched off. An administrator can turn them on from the Workflows page.");
const GATE_AUDIENCES = new Set(["all", "customer"]);

function isDuplicateEntry(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if ((current as { code?: unknown }).code === "ER_DUP_ENTRY") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function createWorkflowTransferService(deps: WorkflowTransferDeps) {
  /**
   * Published policies that gates may use (audience all/customer). Compliance absent ⇒ none (references stay unresolved).
   * Called BEFORE the orders transaction opens: `listPublishedPolicies` uses its own connection, and calling it while
   * holding a tx connection could self-deadlock a small pool. Gates on a draft are re-validated against published
   * policies when the draft is published, so a policy withdrawn in between cannot reach a published workflow.
   */
  async function localPolicies(): Promise<LocalPolicy[]> {
    const compliance = (deps.services as Partial<Services>).compliance as { listPublishedPolicies?: () => Promise<LocalPolicy[]> } | undefined;
    if (typeof compliance?.listPublishedPolicies !== "function") return [];
    const all = await compliance.listPublishedPolicies();
    return all.filter((policy) => GATE_AUDIENCES.has(policy.audience));
  }

  /** Admin + capability re-checked in-tx from persisted state (step-up for `workflows.import`), then the setting. */
  async function guard(principal: SessionPrincipal, tx: Tx, capability: "workflows.export" | "workflows.import") {
    const current = await deps.actorCheck(principal, tx, capability);
    if (current.role !== "admin") throw new DomainError("FORBIDDEN", "ACTOR_NOT_AUTHORIZED", "You do not have permission to perform this action.");
    if (!(await deps.enabled(tx))) throw DISABLED();
  }

  async function takenKeys(db: DbOrTx, keys: string[]) {
    if (!keys.length) return new Set<string>();
    const candidates = new Set<string>();
    for (const key of keys) {
      candidates.add(key);
      for (let n = 2; n < 20; n += 1) candidates.add(`${key.slice(0, 48 - String(n).length - 1)}_${n}`);
    }
    const list = [...candidates];
    const [workflowRows, draftRows] = await Promise.all([
      db.select({ key: orderWorkflows.workflowKey }).from(orderWorkflows).where(inArray(orderWorkflows.workflowKey, list)),
      db.select({ key: orderWorkflowDrafts.workflowKey }).from(orderWorkflowDrafts).where(inArray(orderWorkflowDrafts.workflowKey, list)),
    ]);
    return new Set([...workflowRows.map((row) => row.key), ...draftRows.map((row) => row.key)]);
  }

  /** Key → existing workflow (or standalone draft) on this installation. */
  async function existingByKey(db: DbOrTx, keys: string[]) {
    const out = new Map<string, { workflowId: number | null; workflowPublicId: string | null; name: string; hasDraft: boolean; currentVersionId: number | null }>();
    if (!keys.length) return out;
    const workflowRows = await db
      .select({ id: orderWorkflows.id, publicId: orderWorkflows.publicId, key: orderWorkflows.workflowKey, name: orderWorkflows.name, currentVersionId: orderWorkflows.currentVersionId, draftId: orderWorkflowDrafts.id })
      .from(orderWorkflows)
      .leftJoin(orderWorkflowDrafts, eq(orderWorkflowDrafts.workflowId, orderWorkflows.id))
      .where(inArray(orderWorkflows.workflowKey, keys));
    for (const row of workflowRows) out.set(row.key, { workflowId: row.id, workflowPublicId: row.publicId, name: row.name, hasDraft: row.draftId !== null, currentVersionId: row.currentVersionId });
    const standalone = await db
      .select({ key: orderWorkflowDrafts.workflowKey, name: orderWorkflowDrafts.name })
      .from(orderWorkflowDrafts)
      .where(and(isNull(orderWorkflowDrafts.workflowId), inArray(orderWorkflowDrafts.workflowKey, keys)));
    for (const row of standalone) if (!out.has(row.key)) out.set(row.key, { workflowId: null, workflowPublicId: null, name: row.name, hasDraft: true, currentVersionId: null });
    return out;
  }

  /** Slug matches for every package reference (only non-empty slugs of gate-capable local policies). */
  function matchReferences(policies: readonly PackagePolicy[], local: readonly LocalPolicy[]) {
    const bySlug = new Map(local.map((policy) => [policy.slug, policy]));
    const matches = new Map<string, LocalPolicy>();
    for (const policy of policies) {
      const hit = policy.slug ? bySlug.get(policy.slug) : undefined;
      if (hit) matches.set(policy.ref, hit);
    }
    return matches;
  }

  async function buildPreview(parsed: ParsedPackage, local: LocalPolicy[], db: DbOrTx, tx: Tx): Promise<TransferPreview> {
    const { pkg } = parsed;
    const analysis = analysePackage(parsed);
    const rulesEnabled = await deps.rulesEnabled(tx);
    const matches = matchReferences(pkg.references.policies, local);
    const resolution: GateResolution = new Map([...matches].map(([ref, policy]) => [ref, { localPolicyPublicId: policy.documentPublicId }]));
    const keys = analysis.keys.slice(0, TRANSFER_MAX_WORKFLOWS);
    const [existing, taken] = await Promise.all([existingByKey(db, keys), takenKeys(db, keys)]);
    const assigned = new Set<string>();
    const workflows = pkg.workflows.slice(0, TRANSFER_MAX_WORKFLOWS).map((workflow) => {
      const findings = workflowFindings(workflow, analysis.refs, resolution, rulesEnabled);
      const found = existing.get(workflow.key);
      const suggestedKey = /^[a-z][a-z0-9_]{1,47}$/.test(workflow.key) ? uniqueKey(workflow.key, (key) => taken.has(key) || assigned.has(key)) : workflow.key;
      assigned.add(suggestedKey);
      return {
        key: workflow.key,
        name: workflow.name,
        unpublished: workflow.unpublished,
        valid: !findings.some((finding) => finding.severity === "error"),
        findings: findings.slice(0, 100),
        existing: found ? { workflowPublicId: found.workflowPublicId, name: found.name, hasDraft: found.hasDraft } : null,
        suggestedKey,
      };
    });
    return {
      digest: parsed.digest,
      formatVersion: pkg.formatVersion,
      exportedAt: pkg.exportedAt,
      source: pkg.source,
      blocking: analysis.blocking,
      workflows,
      references: {
        policies: pkg.references.policies.map((policy) => {
          const hit = matches.get(policy.ref);
          return {
            ref: policy.ref,
            slug: policy.slug,
            title: policy.title,
            audience: policy.audience,
            usedBy: analysis.usedBy.get(policy.ref) ?? [],
            resolution: hit ? { status: "matched" as const, localPolicyPublicId: hit.documentPublicId, title: hit.title } : { status: "not_found" as const },
          };
        }),
      },
    };
  }

  /** The canonical request a replay must match: digest + decisions + mappings (order-independent). */
  function requestHash(digest: string, input: TransferApplyInput): string {
    const decisions = [...input.decisions].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const mappings = [...input.policyMappings]
      .map((mapping) => ({ ref: mapping.ref, localPolicyPublicId: mapping.localPolicyPublicId ?? null, removeGates: mapping.removeGates === true }))
      .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    return sha256Hex(canonicalJson({ decisions, digest, mappings }));
  }

  async function replayOf(db: DbOrTx, principal: SessionPrincipal, idempotencyKey: string, hash: string): Promise<TransferApplyResult | null> {
    const [row] = await db
      .select()
      .from(orderWorkflowImports)
      .where(and(eq(orderWorkflowImports.actorUserId, principal.userId), eq(orderWorkflowImports.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (!row) return null;
    if (row.requestHash !== hash) throw conflict("IDEMPOTENCY_KEY_REUSED", "This import was already applied with different choices. Start the import again.");
    return { importPublicId: row.publicId, replayed: true, results: row.outcome.map((entry) => ({ key: entry.key, action: entry.action, workflowKey: entry.workflowKey, draftPublicId: entry.draftPublicId })) };
  }

  return {
    async status(principal: SessionPrincipal): Promise<TransferStatus> {
      return {
        enabled: await deps.enabled(),
        canToggle: principal.role === "admin" && roleHasCapability(principal.role, "workflows.manage"),
        canExport: principal.role === "admin" && roleHasCapability(principal.role, "workflows.export"),
        canImport: principal.role === "admin" && roleHasCapability(principal.role, "workflows.import"),
        maxBytes: TRANSFER_MAX_BYTES,
        maxWorkflows: TRANSFER_MAX_WORKFLOWS,
      };
    },

    /** Increment 06 (D10): the on-page switch. Admin + `workflows.manage`, re-checked in-tx; audited. */
    async setEnabled(principal: SessionPrincipal, input: { enabled: boolean }): Promise<{ enabled: boolean; changed: boolean }> {
      return deps.db.transaction(async (tx) => {
        const current = await deps.actorCheck(principal, tx, "workflows.manage");
        if (current.role !== "admin") throw new DomainError("FORBIDDEN", "ACTOR_NOT_AUTHORIZED", "You do not have permission to perform this action.");
        const before = await deps.enabled(tx);
        if (before === input.enabled) return { enabled: before, changed: false };
        await deps.writeEnabled(input.enabled, tx);
        await deps.audit.record(
          {
            category: "admin",
            eventName: "workflow.transfer_setting_changed",
            action: "update",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "platform_setting" },
            attributes: { setting_key: "orders.workflow_transfer.enabled", from_value: String(before), to_value: String(input.enabled), via: "workflows_page" },
          },
          tx,
        );
        return { enabled: input.enabled, changed: true };
      });
    },

    async exportPackage(principal: SessionPrincipal, input: { selection: TransferSelection }): Promise<{ fileName: string; packageText: string }> {
      const publishedPolicies = await localPolicies(); // outside the tx (see localPolicies)
      return deps.db.transaction(async (tx) => {
        await guard(principal, tx, "workflows.export");
        const wanted = "all" in input.selection ? null : [...new Set(input.selection.workflowKeys)];
        const workflowRows = await tx
          .select({ workflow: orderWorkflows, version: orderWorkflowVersions })
          .from(orderWorkflows)
          .leftJoin(orderWorkflowVersions, eq(orderWorkflowVersions.id, orderWorkflows.currentVersionId))
          .where(wanted ? inArray(orderWorkflows.workflowKey, wanted) : undefined)
          .orderBy(orderWorkflows.workflowKey)
          .limit(TRANSFER_MAX_WORKFLOWS + 1);
        const draftRows = await tx
          .select()
          .from(orderWorkflowDrafts)
          .where(wanted ? inArray(orderWorkflowDrafts.workflowKey, wanted) : undefined)
          .orderBy(orderWorkflowDrafts.workflowKey)
          .limit(TRANSFER_MAX_WORKFLOWS * 2 + 1);
        type Source = { key: string; name: string; unpublished: boolean; definition: WorkflowDraftDefinition; layout: WorkflowLayout | null };
        const sources = new Map<string, Source>();
        for (const { workflow, version } of workflowRows) {
          if (version) {
            const [layoutRow] = await tx.select({ layout: orderWorkflowVersionLayouts.layout }).from(orderWorkflowVersionLayouts).where(eq(orderWorkflowVersionLayouts.versionId, version.id)).limit(1);
            const layout = layoutRow?.layout ? layoutSchema.safeParse(layoutRow.layout) : null;
            const definition = toDraft(workflowDefinitionSchema.parse(version.definition));
            sources.set(workflow.workflowKey, { key: workflow.workflowKey, name: workflow.name, unpublished: false, definition, layout: pruneLayout(layout?.success ? layout.data : null, definition) });
          } else {
            const draft = draftRows.find((row) => row.workflowId === workflow.id);
            if (draft) sources.set(workflow.workflowKey, draftSource(draft));
          }
        }
        for (const draft of draftRows) if (draft.workflowId === null && !sources.has(draft.workflowKey)) sources.set(draft.workflowKey, draftSource(draft));
        if (wanted) for (const key of wanted) if (!sources.has(key)) throw notFound("WORKFLOW_NOT_FOUND");
        if (sources.size === 0) throw validation("NOTHING_TO_EXPORT", "There are no workflows to export yet.");
        if (sources.size > TRANSFER_MAX_WORKFLOWS) throw validation("EXPORT_TOO_MANY", `At most ${TRANSFER_MAX_WORKFLOWS} workflows can be exported at once. Select fewer.`);

        // Local policy ids → portable references (slug, title, audience). Unknown ids still get a reference with an
        // empty slug, so the importing administrator must map them or remove the gate explicitly.
        const local = new Map(publishedPolicies.map((policy) => [policy.documentPublicId, policy]));
        const refOf = new Map<string, string>();
        const policies: PackagePolicy[] = [];
        const workflows = [...sources.values()]
          .sort((a, b) => (a.key < b.key ? -1 : 1))
          .map((source) => {
            const { acceptanceGates, ...rest } = source.definition;
            const gates = (acceptanceGates ?? []).map(({ policyPublicId, ...gate }) => {
              let ref = refOf.get(policyPublicId);
              if (!ref) {
                ref = `policy_${refOf.size + 1}`;
                refOf.set(policyPublicId, ref);
                const known = local.get(policyPublicId);
                policies.push(
                  known
                    ? { ref, slug: known.slug, title: known.title, audience: known.audience }
                    : { ref, slug: "", title: "Policy not published on the source installation", audience: "customer" },
                );
              }
              return { ...gate, policyRef: ref };
            });
            const definition: PackageDefinition = { ...rest, ...(gates.length ? { acceptanceGates: gates } : {}) };
            return { key: source.key, name: source.name, description: null, unpublished: source.unpublished, definition, layout: source.layout };
          });
        const references = { policies };
        // Round-trip through JSON first so the digest covers exactly the values written to the file.
        const plain = JSON.parse(JSON.stringify({ workflows, references })) as { workflows: unknown; references: unknown };
        const digest = packageDigest(plain.workflows, plain.references);
        const now = deps.clock.now();
        const pkg = {
          format: TRANSFER_FORMAT,
          formatVersion: transferFormatVersionFor(workflows.map((workflow) => workflow.definition)),
          exportedAt: now.toISOString(),
          source: { release: deps.release.slice(0, 80), label: deps.installationLabel.slice(0, 120) },
          workflows: plain.workflows,
          references: plain.references,
          integrity: { algorithm: "sha256", digest },
        };
        const packageText = `${JSON.stringify(pkg, null, 2)}\n`;
        if (Buffer.byteLength(packageText, "utf8") > TRANSFER_MAX_BYTES) throw validation("EXPORT_TOO_LARGE", "The export would be larger than 2 MB. Select fewer workflows.");
        await deps.audit.record(
          {
            category: "admin",
            eventName: "workflow.exported",
            action: "export",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "order_workflow_package", publicId: null },
            attributes: { digest, keys: auditSafe(workflows.map((workflow) => workflow.key).join(",")), selection: wanted ? "keys" : "all" },
            safeCounts: { workflows: workflows.length, unpublished: workflows.filter((workflow) => workflow.unpublished).length, policy_references: policies.length },
          },
          tx,
        );
        return { fileName: exportFileName(now), packageText };
      });
    },

    async preview(principal: SessionPrincipal, input: { packageText: string }): Promise<TransferPreview> {
      const publishedPolicies = await localPolicies(); // outside the tx (see localPolicies)
      return deps.db.transaction(async (tx) => {
        await guard(principal, tx, "workflows.import");
        const parsed = parsePackage(input.packageText);
        const preview = await buildPreview(parsed, publishedPolicies, tx, tx);
        await deps.audit.record(
          {
            category: "admin",
            eventName: "workflow.import_previewed",
            action: "import",
            outcome: preview.blocking.length ? "denied" : "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "order_workflow_package", publicId: null },
            ...(preview.blocking.length ? { reasonCode: preview.blocking[0]!.code } : {}),
            attributes: { digest: parsed.digest, digest_matches: parsed.digestMatches, source_label: auditSafe(parsed.pkg.source.label), source_release: auditSafe(parsed.pkg.source.release) },
            safeCounts: {
              workflows: parsed.pkg.workflows.length,
              valid: preview.workflows.filter((workflow) => workflow.valid).length,
              invalid: preview.workflows.filter((workflow) => !workflow.valid).length,
              blocking: preview.blocking.length,
              unresolved_references: preview.references.policies.filter((policy) => policy.resolution.status === "not_found").length,
            },
          },
          tx,
        );
        return preview;
      });
    },

    async applyImport(principal: SessionPrincipal, input: TransferApplyInput): Promise<TransferApplyResult> {
      const parsed = parsePackage(input.packageText);
      const hash = requestHash(parsed.digest, input);
      const publishedPolicies = await localPolicies(); // outside the tx (see localPolicies)
      try {
        return await deps.db.transaction(async (tx) => {
          await guard(principal, tx, "workflows.import");
          // A wrong digest is always blocking, even for a replay of an earlier successful request.
          if (!parsed.digestMatches) throw validation("PACKAGE_BLOCKED", "The file was changed after it was exported. Export it again from the source installation.", { blockingCodes: ["DIGEST_MISMATCH"] });
          const replay = await replayOf(tx, principal, input.idempotencyKey, hash);
          if (replay) return replay;
          const preview = await buildPreview(parsed, publishedPolicies, tx, tx);
          if (preview.blocking.length) throw validation("PACKAGE_BLOCKED", preview.blocking[0]!.message, { blockingCodes: preview.blocking.map((entry) => entry.code) });

          // Decisions: exactly one per workflow in the file.
          const decisionOf = new Map<string, TransferAction>();
          for (const decision of input.decisions) {
            if (decisionOf.has(decision.key)) throw validation("DECISION_DUPLICATE", "Choose one action per workflow.");
            decisionOf.set(decision.key, decision.action);
          }
          const planned = preview.workflows;
          if (decisionOf.size !== planned.length || planned.some((workflow) => !decisionOf.has(workflow.key)))
            throw validation("DECISIONS_INCOMPLETE", "Choose an action (create, add as draft or skip) for every workflow in the file.");
          for (const workflow of planned)
            if (!workflow.valid && decisionOf.get(workflow.key) !== "skip")
              throw validation("WORKFLOW_INVALID", `“${workflow.name.slice(0, 60)}” has problems and can only be skipped. Fix it on the source installation and export again.`, { key: workflow.key });

          // References: matched by slug unless mapped; every unresolved reference used by an applied workflow must be
          // mapped to a published all/customer policy, or its gates removed explicitly.
          const refs = new Map(preview.references.policies.map((policy) => [policy.ref, policy]));
          const local = new Map(publishedPolicies.map((policy) => [policy.documentPublicId, policy]));
          const resolution = new Map<string, { localPolicyPublicId: string } | { removeGates: true }>();
          for (const policy of preview.references.policies) if (policy.resolution.status === "matched") resolution.set(policy.ref, { localPolicyPublicId: policy.resolution.localPolicyPublicId });
          const mappedRefs = new Set<string>();
          for (const mapping of input.policyMappings) {
            if (mappedRefs.has(mapping.ref)) throw validation("POLICY_MAPPING_DUPLICATE", "Each policy reference can be mapped once.");
            mappedRefs.add(mapping.ref);
            if (!refs.has(mapping.ref)) throw validation("POLICY_MAPPING_UNKNOWN_REF", "A policy mapping names a reference that is not in the file.");
            if (mapping.removeGates) resolution.set(mapping.ref, { removeGates: true });
            else if (mapping.localPolicyPublicId && local.has(mapping.localPolicyPublicId)) resolution.set(mapping.ref, { localPolicyPublicId: mapping.localPolicyPublicId });
            else throw validation("POLICY_MAPPING_INVALID", "Choose a published policy for customers, or remove the acceptance gate.");
          }
          for (const policy of preview.references.policies) {
            const applied = policy.usedBy.some((key) => decisionOf.get(key) !== "skip");
            if (applied && !resolution.has(policy.ref))
              throw validation("POLICY_MAPPING_REQUIRED", `Choose a local policy for “${policy.title.slice(0, 80)}”, or remove its acceptance gates.`, { ref: policy.ref });
          }

          const rulesEnabled = await deps.rulesEnabled(tx);
          const now = deps.clock.now();
          const importPublicId = ulid(now.getTime());
          const results: TransferApplyResult["results"] = [];
          const assigned = new Set<string>();
          for (const workflow of parsed.pkg.workflows) {
            const action = decisionOf.get(workflow.key)!;
            if (action === "skip") {
              results.push({ key: workflow.key, action, workflowKey: null, draftPublicId: null });
              continue;
            }
            // Re-validate with the FINAL references (removed gates may change validity).
            const findings = workflowFindings(workflow, new Set(refs.keys()), resolution, rulesEnabled);
            if (findings.some((finding) => finding.severity === "error"))
              throw validation("WORKFLOW_INVALID", `“${workflow.name.slice(0, 60)}” has problems with the chosen policy mappings and can only be skipped.`, { key: workflow.key });
            const definition = draftDefinitionSchema.parse(toDraftDefinition(workflow.definition, resolution));
            const layout = pruneLayout(workflow.layout, definition);
            const name = workflow.name.trim();
            let workflowId: number | null = null;
            let baseVersionId: number | null = null;
            let workflowKey: string;
            if (action === "draft") {
              const [target] = await tx.select().from(orderWorkflows).where(eq(orderWorkflows.workflowKey, workflow.key)).limit(1).for("update");
              if (!target)
                throw validation("IMPORT_NO_EXISTING_WORKFLOW", `There is no workflow with the key “${workflow.key}” to add a draft to. Choose “Create as new workflow”.`, { key: workflow.key });
              const [open] = await tx.select({ publicId: orderWorkflowDrafts.publicId }).from(orderWorkflowDrafts).where(eq(orderWorkflowDrafts.workflowId, target.id)).limit(1);
              if (open) throw new DomainError("CONFLICT", "WORKFLOW_DRAFT_EXISTS", `“${target.name.slice(0, 60)}” already has a draft. Publish or discard it first, or choose “Create as new workflow”.`, { key: workflow.key });
              workflowId = target.id;
              baseVersionId = target.currentVersionId;
              workflowKey = target.workflowKey;
            } else {
              const taken = await takenKeys(tx, [workflow.key]);
              workflowKey = uniqueKey(workflow.key, (key) => taken.has(key) || assigned.has(key));
              if (taken.has(workflowKey)) {
                // Outside the pre-fetched candidates: check precisely.
                const [hit] = await tx.select({ id: orderWorkflows.id }).from(orderWorkflows).where(eq(orderWorkflows.workflowKey, workflowKey)).limit(1);
                if (hit) throw conflict("WORKFLOW_KEY_TAKEN", "A workflow with that key already exists.");
              }
            }
            assigned.add(workflowKey);
            const draftPublicId = ulid(now.getTime());
            await tx.insert(orderWorkflowDrafts).values({
              publicId: draftPublicId,
              workflowId,
              workflowKey,
              name,
              // No "import" draft source exists in the schema (frozen); provenance is the import row and the audit.
              source: "blank",
              baseVersionId,
              definition,
              layout,
              createdByUserId: principal.userId,
              updatedByUserId: principal.userId,
              createdAt: now,
              updatedAt: now,
            });
            results.push({ key: workflow.key, action, workflowKey, draftPublicId });
          }

          await tx.insert(orderWorkflowImports).values({
            publicId: importPublicId,
            actorUserId: principal.userId,
            idempotencyKey: input.idempotencyKey,
            digest: parsed.digest,
            requestHash: hash,
            sourceLabel: parsed.pkg.source.label.slice(0, 120) || null,
            outcome: results,
            createdAt: now,
          });
          const counts = { created: 0, drafted: 0, skipped: 0 };
          for (const result of results) counts[result.action === "create" ? "created" : result.action === "draft" ? "drafted" : "skipped"] += 1;
          await deps.audit.record(
            {
              category: "admin",
              eventName: "workflow.imported",
              action: "import",
              outcome: "completed",
              actor: { userId: principal.userId, role: principal.role },
              resource: { type: "order_workflow_import", publicId: importPublicId },
              importId: importPublicId,
              attributes: {
                digest: parsed.digest,
                source_label: auditSafe(parsed.pkg.source.label),
                outcome: auditSafe(results.map((result) => `${result.key}:${result.action}${result.workflowKey && result.workflowKey !== result.key ? `=${result.workflowKey}` : ""}`).join(",")),
                gates_removed: [...resolution.values()].some((entry) => "removeGates" in entry),
              },
              safeCounts: { ...counts, workflows: results.length },
            },
            tx,
          );
          return { importPublicId, replayed: false, results };
        });
      } catch (error) {
        // A concurrent apply with the same key committed first: return its result (or refuse a different request).
        if (isDuplicateEntry(error)) {
          const replay = await replayOf(deps.db, principal, input.idempotencyKey, hash);
          if (replay) return replay;
        }
        throw error;
      }
    },
  };

  function draftSource(draft: typeof orderWorkflowDrafts.$inferSelect) {
    const definition = draftDefinitionSchema.parse(draft.definition);
    const layout = draft.layout ? layoutSchema.safeParse(draft.layout) : null;
    return { key: draft.workflowKey, name: draft.name, unpublished: true, definition, layout: pruneLayout(layout?.success ? layout.data : null, definition) };
  }
}

export type WorkflowTransferService = ReturnType<typeof createWorkflowTransferService>;
