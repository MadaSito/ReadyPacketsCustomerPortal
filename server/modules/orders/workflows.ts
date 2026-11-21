/**
 * Versioned workflow definitions. Orders are bound to the version they started on; publishing a new version
 * affects new orders only (an explicit migration of existing orders is a recorded target, not implemented).
 */
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { conflict, DomainError, notFound, validation } from "../../core/errors.js";
import { STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";
import { ulid } from "../../core/ids.js";
import type { ActorCheck } from "./actor.js";
import type { AuditEmitter, Clock, Db, DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { orders, orderWorkflowDrafts, orderWorkflows, orderWorkflowVersionLayouts, orderWorkflowVersions, type WorkflowDraftSource } from "./schema.js";
import { DEFAULT_WORKFLOW, workflowDefinitionSchema, type WorkflowDefinition } from "./workflowTypes.js";
import {
  BLANK_DRAFT,
  draftDefinitionSchema,
  hasErrors,
  layoutSchema,
  pruneLayout,
  toDraft,
  toPublishable,
  validateDraft,
  type WorkflowDraftDefinition,
  type WorkflowIssue,
  type WorkflowLayout,
} from "./workflowDesign.js";

export interface WorkflowDeps {
  db: Db;
  clock: Clock;
  audit: AuditEmitter;
  /** In-tx actor re-validation (first statement of every admin write; these writes lock no order row). */
  actorCheck: ActorCheck;
}

export interface BoundWorkflow {
  workflowId: number;
  workflowKey: string;
  versionId: number;
  versionNumber: number;
  definition: WorkflowDefinition;
}

const DEFAULT_KEY = "standard";

export function createWorkflowService(deps: WorkflowDeps) {
  /** Versions are immutable, so caching by id is safe. */
  const versionCache = new Map<number, BoundWorkflow>();

  async function byVersionId(db: DbOrTx, versionId: number): Promise<BoundWorkflow> {
    const cached = versionCache.get(versionId);
    if (cached) return cached;
    const [row] = await db
      .select({ version: orderWorkflowVersions, workflowKey: orderWorkflows.workflowKey })
      .from(orderWorkflowVersions)
      .innerJoin(orderWorkflows, eq(orderWorkflows.id, orderWorkflowVersions.workflowId))
      .where(eq(orderWorkflowVersions.id, versionId))
      .limit(1);
    if (!row) throw notFound("WORKFLOW_NOT_FOUND");
    const bound: BoundWorkflow = {
      workflowId: row.version.workflowId,
      workflowKey: row.workflowKey,
      versionId: row.version.id,
      versionNumber: row.version.versionNumber,
      definition: workflowDefinitionSchema.parse(row.version.definition),
    };
    versionCache.set(versionId, bound);
    return bound;
  }

  async function insertVersion(tx: Tx, workflowId: number, versionNumber: number, definition: WorkflowDefinition, actorUserId: number | null) {
    const publicId = ulid(deps.clock.now().getTime());
    await tx.insert(orderWorkflowVersions).values({
      publicId,
      workflowId,
      versionNumber,
      definition,
      createdByUserId: actorUserId,
      createdAt: deps.clock.now(),
    });
    const [row] = await tx.select({ id: orderWorkflowVersions.id }).from(orderWorkflowVersions).where(eq(orderWorkflowVersions.publicId, publicId));
    return row!.id;
  }

  async function currentDefault(db: DbOrTx): Promise<BoundWorkflow | null> {
    const [row] = await db
      .select({ currentVersionId: orderWorkflows.currentVersionId })
      .from(orderWorkflows)
      .where(eq(orderWorkflows.isDefault, true))
      .orderBy(asc(orderWorkflows.id))
      .limit(1);
    return row?.currentVersionId ? byVersionId(db, row.currentVersionId) : null;
  }

  /** Inserts the standard workflow as the default (caller verified none exists). `principal` null = system. */
  async function installStandardTx(tx: Tx, principal: SessionPrincipal | null): Promise<BoundWorkflow> {
    const [taken] = await tx.select({ id: orderWorkflows.id }).from(orderWorkflows).where(eq(orderWorkflows.workflowKey, DEFAULT_KEY)).limit(1);
    if (taken) throw conflict("WORKFLOW_KEY_TAKEN", "A workflow with the key “standard” already exists. Make it the default instead.");
    const publicId = ulid(deps.clock.now().getTime());
    await tx.insert(orderWorkflows).values({ publicId, workflowKey: DEFAULT_KEY, name: "Standard", isDefault: true });
    const [workflow] = await tx.select({ id: orderWorkflows.id }).from(orderWorkflows).where(eq(orderWorkflows.publicId, publicId));
    const versionId = await insertVersion(tx, workflow!.id, 1, DEFAULT_WORKFLOW, principal?.userId ?? null);
    await tx.update(orderWorkflows).set({ currentVersionId: versionId }).where(eq(orderWorkflows.id, workflow!.id));
    await deps.audit.record(
      {
        category: principal ? "admin" : "system",
        eventName: "workflow.changed",
        action: "create",
        outcome: "completed",
        actor: principal ? { userId: principal.userId, role: principal.role } : { role: "system" },
        resource: { type: "order_workflow", publicId },
        reasonCode: principal ? "STANDARD_INSTALLED" : "DEFAULT_INSTALLED",
        safeCounts: { states: DEFAULT_WORKFLOW.states.length, transitions: DEFAULT_WORKFLOW.transitions.length },
      },
      tx,
    );
    return byVersionId(tx, versionId);
  }

  /** Re-validates the actor in-tx and, for publish-class writes, requires a fresh PERSISTED step-up. */
  async function assertDesigner(principal: SessionPrincipal, tx: Tx, needsStepUp: boolean) {
    const current = await deps.actorCheck(principal, tx, "workflows.manage");
    if (current.role !== "admin") throw new DomainError("FORBIDDEN", "ACTOR_NOT_AUTHORIZED", "You do not have permission to perform this action.");
    if (needsStepUp) {
      const at = current.stepUpAt?.getTime();
      if (at === undefined || deps.clock.now().getTime() - at > STEP_UP_MAX_AGE_MS)
        throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Please confirm your password and authentication code to continue.");
    }
  }

  async function layoutOf(db: DbOrTx, versionId: number): Promise<{ layout: WorkflowLayout | null; changeNote: string | null }> {
    const [row] = await db
      .select({ layout: orderWorkflowVersionLayouts.layout, changeNote: orderWorkflowVersionLayouts.changeNote })
      .from(orderWorkflowVersionLayouts)
      .where(eq(orderWorkflowVersionLayouts.versionId, versionId))
      .limit(1);
    const parsed = row?.layout ? layoutSchema.safeParse(row.layout) : null;
    return { layout: parsed?.success ? parsed.data : null, changeNote: row?.changeNote ?? null };
  }

  function draftView(row: typeof orderWorkflowDrafts.$inferSelect, workflowPublicId: string | null, baseVersionNumber: number | null) {
    const definition = draftDefinitionSchema.parse(row.definition);
    const issues = validateDraft(definition);
    return {
      publicId: row.publicId,
      workflowPublicId,
      workflowKey: row.workflowKey,
      name: row.name,
      source: row.source,
      baseVersionNumber,
      definition,
      layout: pruneLayout(row.layout ? layoutSchema.parse(row.layout) : null, definition),
      rowVersion: row.version,
      updatedAt: row.updatedAt,
      issues,
      publishable: !hasErrors(issues),
    };
  }

  async function loadDraftRow(db: DbOrTx, draftPublicId: string, forUpdate: boolean) {
    const query = db.select().from(orderWorkflowDrafts).where(eq(orderWorkflowDrafts.publicId, draftPublicId)).limit(1);
    const [row] = forUpdate ? await query.for("update") : await query;
    if (!row) throw notFound("WORKFLOW_DRAFT_NOT_FOUND");
    return row;
  }

  async function draftContext(db: DbOrTx, row: typeof orderWorkflowDrafts.$inferSelect) {
    let workflowPublicId: string | null = null;
    let baseVersionNumber: number | null = null;
    if (row.workflowId !== null) {
      const [workflow] = await db.select({ publicId: orderWorkflows.publicId }).from(orderWorkflows).where(eq(orderWorkflows.id, row.workflowId)).limit(1);
      workflowPublicId = workflow?.publicId ?? null;
    }
    if (row.baseVersionId !== null) {
      const [base] = await db.select({ n: orderWorkflowVersions.versionNumber }).from(orderWorkflowVersions).where(eq(orderWorkflowVersions.id, row.baseVersionId)).limit(1);
      baseVersionNumber = base?.n ?? null;
    }
    return { workflowPublicId, baseVersionNumber };
  }

  const staleDraft = () => conflict("STALE_VERSION", "This draft was changed by someone else. Reload and try again.");

  return {
    byVersionId,
    currentDefault,

    /* ------------------------------------------------------- designer (increment 03) */

    /** Explicit admin action: install the standard workflow now. Idempotent: `installed: false` when a default exists. */
    async installStandard(principal: SessionPrincipal): Promise<{ installed: boolean; workflowPublicId: string; versionNumber: number }> {
      return deps.db.transaction(async (tx) => {
        await assertDesigner(principal, tx, true);
        const existing = await currentDefault(tx);
        const bound = existing ?? (await installStandardTx(tx, principal));
        const [workflow] = await tx.select({ publicId: orderWorkflows.publicId }).from(orderWorkflows).where(eq(orderWorkflows.id, bound.workflowId)).limit(1);
        return { installed: !existing, workflowPublicId: workflow!.publicId, versionNumber: bound.versionNumber };
      });
    },

    async listDrafts() {
      const rows = await deps.db
        .select({ draft: orderWorkflowDrafts, workflowPublicId: orderWorkflows.publicId })
        .from(orderWorkflowDrafts)
        .leftJoin(orderWorkflows, eq(orderWorkflows.id, orderWorkflowDrafts.workflowId))
        .orderBy(desc(orderWorkflowDrafts.updatedAt), desc(orderWorkflowDrafts.id))
        .limit(50);
      return rows.map(({ draft, workflowPublicId }) => {
        const definition = draftDefinitionSchema.parse(draft.definition);
        const issues = validateDraft(definition);
        return {
          publicId: draft.publicId,
          workflowPublicId,
          workflowKey: draft.workflowKey,
          name: draft.name,
          source: draft.source,
          rowVersion: draft.version,
          updatedAt: draft.updatedAt,
          errorCount: issues.filter((issue) => issue.severity === "error").length,
          warningCount: issues.filter((issue) => issue.severity === "warning").length,
        };
      });
    },

    async getDraft(draftPublicId: string) {
      const row = await loadDraftRow(deps.db, draftPublicId, false);
      const context = await draftContext(deps.db, row);
      return draftView(row, context.workflowPublicId, context.baseVersionNumber);
    },

    /**
     * Starts a draft. `workflowId` set ⇒ edits that workflow (one draft per workflow); otherwise a new workflow
     * with `workflowKey` + `name`. `from`: the standard definition, a copy of a published version, or blank.
     */
    async createDraft(
      principal: SessionPrincipal,
      input: { from: WorkflowDraftSource; copyVersionId?: string; workflowId?: string; workflowKey?: string; name?: string },
    ) {
      return deps.db.transaction(async (tx) => {
        await assertDesigner(principal, tx, false);
        let definition: WorkflowDraftDefinition;
        let layout: WorkflowLayout | null = null;
        if (input.from === "copy") {
          if (!input.copyVersionId) throw validation("COPY_VERSION_REQUIRED", "Choose the published version to copy.");
          const [version] = await tx.select().from(orderWorkflowVersions).where(eq(orderWorkflowVersions.publicId, input.copyVersionId)).limit(1);
          if (!version) throw notFound("WORKFLOW_VERSION_NOT_FOUND");
          definition = toDraft(workflowDefinitionSchema.parse(version.definition));
          layout = (await layoutOf(tx, version.id)).layout;
        } else definition = input.from === "standard" ? toDraft(DEFAULT_WORKFLOW) : structuredClone(BLANK_DRAFT);

        let workflowId: number | null = null;
        let baseVersionId: number | null = null;
        let workflowKey: string;
        let name: string;
        if (input.workflowId) {
          const [workflow] = await tx.select().from(orderWorkflows).where(eq(orderWorkflows.publicId, input.workflowId)).limit(1);
          if (!workflow) throw notFound("WORKFLOW_NOT_FOUND");
          const [open] = await tx.select({ publicId: orderWorkflowDrafts.publicId }).from(orderWorkflowDrafts).where(eq(orderWorkflowDrafts.workflowId, workflow.id)).limit(1);
          if (open) throw new DomainError("CONFLICT", "WORKFLOW_DRAFT_EXISTS", "This workflow already has a draft. Open it, or discard it first.", { draftId: open.publicId });
          workflowId = workflow.id;
          baseVersionId = workflow.currentVersionId;
          workflowKey = workflow.workflowKey;
          name = input.name ?? workflow.name;
        } else {
          if (!input.workflowKey || !input.name) throw validation("WORKFLOW_NAME_REQUIRED", "Enter a name and a key for the new workflow.");
          const [taken] = await tx.select({ id: orderWorkflows.id }).from(orderWorkflows).where(eq(orderWorkflows.workflowKey, input.workflowKey)).limit(1);
          const [drafted] = await tx.select({ id: orderWorkflowDrafts.id }).from(orderWorkflowDrafts).where(eq(orderWorkflowDrafts.workflowKey, input.workflowKey)).limit(1);
          if (taken || drafted) throw conflict("WORKFLOW_KEY_TAKEN", "A workflow or draft with that key already exists.");
          workflowKey = input.workflowKey;
          name = input.name;
        }
        const publicId = ulid(deps.clock.now().getTime());
        const now = deps.clock.now();
        await tx.insert(orderWorkflowDrafts).values({
          publicId,
          workflowId,
          workflowKey,
          name,
          source: input.from,
          baseVersionId,
          definition,
          layout,
          createdByUserId: principal.userId,
          updatedByUserId: principal.userId,
          createdAt: now,
          updatedAt: now,
        });
        await deps.audit.record(
          {
            category: "admin",
            eventName: "workflow.draft.changed",
            action: "create",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "order_workflow_draft", publicId },
            attributes: { source: input.from, existing_workflow: workflowId !== null },
            safeCounts: { states: definition.states.length, transitions: definition.transitions.length },
          },
          tx,
        );
        return { publicId, rowVersion: 1 };
      });
    },

    /** Saves work in progress (may be invalid); returns the current issues so the client can show them. */
    async saveDraft(principal: SessionPrincipal, input: { draftId: string; expectedVersion: number; name: string; definition: unknown; layout?: unknown }) {
      const parsed = draftDefinitionSchema.safeParse(input.definition);
      if (!parsed.success) throw validation("INVALID_WORKFLOW_DRAFT", "The draft could not be saved: it is too large or has unsupported values.");
      const definition = parsed.data;
      let layout: WorkflowLayout | null | undefined;
      if (input.layout !== undefined) {
        const parsedLayout = layoutSchema.nullable().safeParse(input.layout);
        if (!parsedLayout.success) throw validation("INVALID_WORKFLOW_LAYOUT", "The canvas positions could not be saved.");
        layout = pruneLayout(parsedLayout.data, definition);
      }
      return deps.db.transaction(async (tx) => {
        await assertDesigner(principal, tx, false);
        const row = await loadDraftRow(tx, input.draftId, true);
        if (row.version !== input.expectedVersion) throw staleDraft();
        await tx
          .update(orderWorkflowDrafts)
          .set({
            name: input.name,
            definition,
            ...(layout !== undefined ? { layout } : {}),
            updatedByUserId: principal.userId,
            version: row.version + 1,
            updatedAt: deps.clock.now(),
          })
          .where(and(eq(orderWorkflowDrafts.id, row.id), eq(orderWorkflowDrafts.version, row.version)));
        await deps.audit.record(
          {
            category: "admin",
            eventName: "workflow.draft.changed",
            action: "update",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "order_workflow_draft", publicId: row.publicId },
            safeCounts: { states: definition.states.length, transitions: definition.transitions.length },
          },
          tx,
        );
        const issues = validateDraft(definition);
        return { rowVersion: row.version + 1, issues, publishable: !hasErrors(issues) };
      });
    },

    async discardDraft(principal: SessionPrincipal, input: { draftId: string; expectedVersion: number }) {
      return deps.db.transaction(async (tx) => {
        await assertDesigner(principal, tx, false);
        const row = await loadDraftRow(tx, input.draftId, true);
        if (row.version !== input.expectedVersion) throw staleDraft();
        await tx.delete(orderWorkflowDrafts).where(eq(orderWorkflowDrafts.id, row.id));
        await deps.audit.record(
          {
            category: "admin",
            eventName: "workflow.draft.changed",
            action: "delete",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "order_workflow_draft", publicId: row.publicId },
          },
          tx,
        );
        return { discarded: true };
      });
    },

    /**
     * Publishes a draft as a NEW immutable version (or a new workflow). Existing orders keep the version they
     * started on. Lock order: draft row, then workflow row. Refuses when the workflow was published again after
     * the draft started (WORKFLOW_CHANGED_SINCE_DRAFT). Requires fresh step-up. The draft is removed on success.
     */
    async publishDraft(principal: SessionPrincipal, input: { draftId: string; expectedVersion: number; makeDefault: boolean; changeNote?: string }) {
      return deps.db.transaction(async (tx) => {
        await assertDesigner(principal, tx, true);
        const row = await loadDraftRow(tx, input.draftId, true);
        if (row.version !== input.expectedVersion) throw staleDraft();
        const draft = draftDefinitionSchema.parse(row.definition);
        const issues = validateDraft(draft);
        if (hasErrors(issues)) {
          const errors = issues.filter((issue) => issue.severity === "error").slice(0, 50);
          throw validation("WORKFLOW_DRAFT_INVALID", "Fix the problems listed before publishing.", {
            issues: errors.map((issue) => issue.message),
            issuePaths: errors.map((issue) => issue.path),
            issueCodes: errors.map((issue) => issue.code),
          });
        }
        const definition = toPublishable(draft);
        const layout = pruneLayout(row.layout ? layoutSchema.parse(row.layout) : null, draft);
        const [hasDefault] = await tx.select({ id: orderWorkflows.id }).from(orderWorkflows).where(eq(orderWorkflows.isDefault, true)).limit(1);
        let workflowRow: typeof orderWorkflows.$inferSelect;
        let versionNumber: number;
        if (row.workflowId !== null) {
          const [workflow] = await tx.select().from(orderWorkflows).where(eq(orderWorkflows.id, row.workflowId)).limit(1).for("update");
          if (!workflow) throw notFound("WORKFLOW_NOT_FOUND");
          if (workflow.currentVersionId !== row.baseVersionId)
            throw conflict("WORKFLOW_CHANGED_SINCE_DRAFT", "A newer version of this workflow was published after this draft was started. Discard the draft and start again from the current version.");
          workflowRow = workflow;
          const [latest] = await tx
            .select({ n: orderWorkflowVersions.versionNumber })
            .from(orderWorkflowVersions)
            .where(eq(orderWorkflowVersions.workflowId, workflow.id))
            .orderBy(desc(orderWorkflowVersions.versionNumber))
            .limit(1);
          versionNumber = (latest?.n ?? 0) + 1;
        } else {
          const [taken] = await tx.select({ id: orderWorkflows.id }).from(orderWorkflows).where(eq(orderWorkflows.workflowKey, row.workflowKey)).limit(1);
          if (taken) throw conflict("WORKFLOW_KEY_TAKEN", "A workflow with that key already exists.");
          const publicId = ulid(deps.clock.now().getTime());
          await tx.insert(orderWorkflows).values({ publicId, workflowKey: row.workflowKey, name: row.name, isDefault: false });
          const [created] = await tx.select().from(orderWorkflows).where(eq(orderWorkflows.publicId, publicId)).limit(1);
          workflowRow = created!;
          versionNumber = 1;
        }
        // The first published workflow becomes the default so new orders never fall back to the standard silently.
        const makeDefault = input.makeDefault || !hasDefault;
        const versionId = await insertVersion(tx, workflowRow.id, versionNumber, definition, principal.userId);
        await tx.insert(orderWorkflowVersionLayouts).values({ versionId, layout, changeNote: input.changeNote ?? null, createdAt: deps.clock.now() });
        if (makeDefault) await tx.update(orderWorkflows).set({ isDefault: false }).where(eq(orderWorkflows.isDefault, true));
        await tx
          .update(orderWorkflows)
          .set({ name: row.name, currentVersionId: versionId, isDefault: makeDefault || workflowRow.isDefault, version: workflowRow.version + 1 })
          .where(and(eq(orderWorkflows.id, workflowRow.id), eq(orderWorkflows.version, workflowRow.version)));
        await tx.delete(orderWorkflowDrafts).where(eq(orderWorkflowDrafts.id, row.id));
        await deps.audit.record(
          {
            category: "admin",
            eventName: "workflow.changed",
            action: "publish",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "order_workflow", publicId: workflowRow.publicId },
            attributes: { version_number: versionNumber, make_default: makeDefault, source: row.source, draft_id: row.publicId, warnings: issues.length },
            safeCounts: { states: definition.states.length, transitions: definition.transitions.length },
          },
          tx,
        );
        return { workflowPublicId: workflowRow.publicId, versionNumber, isDefault: makeDefault || workflowRow.isDefault };
      });
    },

    /** Published versions of one workflow, newest first, with how many orders are bound to each. */
    async listVersions(workflowPublicId: string) {
      const [workflow] = await deps.db.select().from(orderWorkflows).where(eq(orderWorkflows.publicId, workflowPublicId)).limit(1);
      if (!workflow) throw notFound("WORKFLOW_NOT_FOUND");
      const versions = await deps.db
        .select({ id: orderWorkflowVersions.id, publicId: orderWorkflowVersions.publicId, versionNumber: orderWorkflowVersions.versionNumber, definition: orderWorkflowVersions.definition, createdAt: orderWorkflowVersions.createdAt, changeNote: orderWorkflowVersionLayouts.changeNote })
        .from(orderWorkflowVersions)
        .leftJoin(orderWorkflowVersionLayouts, eq(orderWorkflowVersionLayouts.versionId, orderWorkflowVersions.id))
        .where(eq(orderWorkflowVersions.workflowId, workflow.id))
        .orderBy(desc(orderWorkflowVersions.versionNumber))
        .limit(100);
      const ids = versions.map((version) => version.id);
      const counts = ids.length
        ? await deps.db.select({ versionId: orders.workflowVersionId, n: count() }).from(orders).where(inArray(orders.workflowVersionId, ids)).groupBy(orders.workflowVersionId)
        : [];
      const byId = new Map(counts.map((entry) => [entry.versionId, Number(entry.n)]));
      return {
        workflow: { publicId: workflow.publicId, workflowKey: workflow.workflowKey, name: workflow.name, isDefault: workflow.isDefault },
        versions: versions.map((version) => {
          const definition = workflowDefinitionSchema.parse(version.definition);
          return {
            publicId: version.publicId,
            versionNumber: version.versionNumber,
            isCurrent: version.id === workflow.currentVersionId,
            createdAt: version.createdAt,
            changeNote: version.changeNote ?? null,
            stateCount: definition.states.length,
            transitionCount: definition.transitions.length,
            orderCount: byId.get(version.id) ?? 0,
          };
        }),
      };
    },

    /** Read-only view of one published version (definition + canvas layout). */
    async getVersion(versionPublicId: string) {
      const [version] = await deps.db
        .select({ version: orderWorkflowVersions, workflow: orderWorkflows })
        .from(orderWorkflowVersions)
        .innerJoin(orderWorkflows, eq(orderWorkflows.id, orderWorkflowVersions.workflowId))
        .where(eq(orderWorkflowVersions.publicId, versionPublicId))
        .limit(1);
      if (!version) throw notFound("WORKFLOW_VERSION_NOT_FOUND");
      const extra = await layoutOf(deps.db, version.version.id);
      return {
        publicId: version.version.publicId,
        workflowPublicId: version.workflow.publicId,
        workflowName: version.workflow.name,
        versionNumber: version.version.versionNumber,
        isCurrent: version.workflow.currentVersionId === version.version.id,
        createdAt: version.version.createdAt,
        definition: workflowDefinitionSchema.parse(version.version.definition),
        layout: extra.layout,
        changeNote: extra.changeNote,
      };
    },

    /** Pure validation for a draft body that has not been saved yet (wizard "Check" button). */
    validate(definition: unknown): { issues: WorkflowIssue[]; publishable: boolean } {
      const parsed = draftDefinitionSchema.safeParse(definition);
      if (!parsed.success) return { issues: [{ severity: "error", code: "DRAFT_SHAPE", path: "", message: "The workflow is too large or has unsupported values." }], publishable: false };
      const issues = validateDraft(parsed.data);
      return { issues, publishable: !hasErrors(issues) };
    },

    /** Returns the default workflow, installing the neutral starter definition once if none exists. */
    async ensureDefault(tx: Tx): Promise<BoundWorkflow> {
      const existing = await currentDefault(tx);
      if (existing) return existing;
      return installStandardTx(tx, null);
    },

    async list() {
      const rows = await deps.db
        .select({ workflow: orderWorkflows, version: orderWorkflowVersions, draftPublicId: orderWorkflowDrafts.publicId })
        .from(orderWorkflows)
        .leftJoin(orderWorkflowVersions, eq(orderWorkflowVersions.id, orderWorkflows.currentVersionId))
        .leftJoin(orderWorkflowDrafts, eq(orderWorkflowDrafts.workflowId, orderWorkflows.id))
        .orderBy(desc(orderWorkflows.isDefault), asc(orderWorkflows.id))
        .limit(50);
      return rows.map(({ workflow, version, draftPublicId }) => ({
        publicId: workflow.publicId,
        workflowKey: workflow.workflowKey,
        name: workflow.name,
        isDefault: workflow.isDefault,
        rowVersion: workflow.version,
        versionNumber: version?.versionNumber ?? 0,
        /** Increment 03: for "copy" drafts and the read-only view. */
        currentVersionPublicId: version?.publicId ?? null,
        /** Increment 03: the open draft editing this workflow, if any. */
        draftPublicId: draftPublicId ?? null,
        definition: version ? workflowDefinitionSchema.parse(version.definition) : null,
      }));
    },

    async create(principal: SessionPrincipal, input: { workflowKey: string; name: string; definition: unknown }) {
      const definition = parseDefinition(input.definition);
      return deps.db.transaction(async (tx) => {
        await deps.actorCheck(principal, tx, "workflows.manage");
        const [taken] = await tx.select({ id: orderWorkflows.id }).from(orderWorkflows).where(eq(orderWorkflows.workflowKey, input.workflowKey)).limit(1);
        if (taken) throw conflict("WORKFLOW_KEY_TAKEN", "A workflow with that key already exists.");
        const publicId = ulid(deps.clock.now().getTime());
        await tx.insert(orderWorkflows).values({ publicId, workflowKey: input.workflowKey, name: input.name, isDefault: false });
        const [workflow] = await tx.select({ id: orderWorkflows.id }).from(orderWorkflows).where(eq(orderWorkflows.publicId, publicId));
        const versionId = await insertVersion(tx, workflow!.id, 1, definition, principal.userId);
        await tx.update(orderWorkflows).set({ currentVersionId: versionId }).where(eq(orderWorkflows.id, workflow!.id));
        await deps.audit.record(
          {
            category: "admin",
            eventName: "workflow.changed",
            action: "create",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "order_workflow", publicId },
            safeCounts: { states: definition.states.length, transitions: definition.transitions.length },
          },
          tx,
        );
        return { publicId, versionNumber: 1 };
      });
    },

    /** Publishes a new immutable version (and optionally makes this workflow the default for new orders). */
    async publish(
      principal: SessionPrincipal,
      input: { workflowId: string; expectedVersion: number; name: string; definition: unknown; makeDefault: boolean },
    ) {
      const definition = parseDefinition(input.definition);
      return deps.db.transaction(async (tx) => {
        await deps.actorCheck(principal, tx, "workflows.manage");
        const [workflow] = await tx.select().from(orderWorkflows).where(eq(orderWorkflows.publicId, input.workflowId)).limit(1).for("update");
        if (!workflow) throw notFound("WORKFLOW_NOT_FOUND");
        if (workflow.version !== input.expectedVersion)
          throw conflict("STALE_VERSION", "This workflow was changed by someone else. Reload and try again.");
        const [latest] = await tx
          .select({ n: orderWorkflowVersions.versionNumber })
          .from(orderWorkflowVersions)
          .where(eq(orderWorkflowVersions.workflowId, workflow.id))
          .orderBy(desc(orderWorkflowVersions.versionNumber))
          .limit(1);
        const versionNumber = (latest?.n ?? 0) + 1;
        const versionId = await insertVersion(tx, workflow.id, versionNumber, definition, principal.userId);
        if (input.makeDefault) await tx.update(orderWorkflows).set({ isDefault: false }).where(eq(orderWorkflows.isDefault, true));
        await tx
          .update(orderWorkflows)
          .set({
            name: input.name,
            currentVersionId: versionId,
            isDefault: input.makeDefault || workflow.isDefault,
            version: workflow.version + 1,
          })
          .where(and(eq(orderWorkflows.id, workflow.id), eq(orderWorkflows.version, workflow.version)));
        await deps.audit.record(
          {
            category: "admin",
            eventName: "workflow.changed",
            action: "publish",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "order_workflow", publicId: workflow.publicId },
            attributes: { version_number: versionNumber, make_default: input.makeDefault },
            safeCounts: { states: definition.states.length, transitions: definition.transitions.length },
          },
          tx,
        );
        return { publicId: workflow.publicId, versionNumber, rowVersion: workflow.version + 1 };
      });
    },
  };
}

function parseDefinition(raw: unknown): WorkflowDefinition {
  const parsed = workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw validation("INVALID_WORKFLOW", "The workflow definition is not valid.", {
      issues: parsed.error.issues.slice(0, 10).map((issue) => issue.message),
    });
  }
  return parsed.data;
}

export type WorkflowService = ReturnType<typeof createWorkflowService>;
