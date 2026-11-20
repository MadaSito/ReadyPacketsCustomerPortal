/**
 * Versioned workflow definitions. Orders are bound to the version they started on; publishing a new version
 * affects new orders only (an explicit migration of existing orders is a recorded target, not implemented).
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { conflict, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { AuditEmitter, Clock, Db, DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { orderWorkflows, orderWorkflowVersions } from "./schema.js";
import { DEFAULT_WORKFLOW, workflowDefinitionSchema, type WorkflowDefinition } from "./workflowTypes.js";

export interface WorkflowDeps {
  db: Db;
  clock: Clock;
  audit: AuditEmitter;
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

  return {
    byVersionId,
    currentDefault,

    /** Returns the default workflow, installing the neutral starter definition once if none exists. */
    async ensureDefault(tx: Tx): Promise<BoundWorkflow> {
      const existing = await currentDefault(tx);
      if (existing) return existing;
      const publicId = ulid(deps.clock.now().getTime());
      await tx.insert(orderWorkflows).values({ publicId, workflowKey: DEFAULT_KEY, name: "Standard", isDefault: true });
      const [workflow] = await tx.select({ id: orderWorkflows.id }).from(orderWorkflows).where(eq(orderWorkflows.publicId, publicId));
      const versionId = await insertVersion(tx, workflow!.id, 1, DEFAULT_WORKFLOW, null);
      await tx.update(orderWorkflows).set({ currentVersionId: versionId }).where(eq(orderWorkflows.id, workflow!.id));
      await deps.audit.record(
        {
          category: "system",
          eventName: "workflow.changed",
          action: "create",
          outcome: "completed",
          actor: { role: "system" },
          resource: { type: "order_workflow", publicId },
          reasonCode: "DEFAULT_INSTALLED",
        },
        tx,
      );
      return byVersionId(tx, versionId);
    },

    async list() {
      const rows = await deps.db
        .select({ workflow: orderWorkflows, version: orderWorkflowVersions })
        .from(orderWorkflows)
        .leftJoin(orderWorkflowVersions, eq(orderWorkflowVersions.id, orderWorkflows.currentVersionId))
        .orderBy(desc(orderWorkflows.isDefault), asc(orderWorkflows.id))
        .limit(50);
      return rows.map(({ workflow, version }) => ({
        publicId: workflow.publicId,
        workflowKey: workflow.workflowKey,
        name: workflow.name,
        isDefault: workflow.isDefault,
        rowVersion: workflow.version,
        versionNumber: version?.versionNumber ?? 0,
        definition: version ? workflowDefinitionSchema.parse(version.definition) : null,
      }));
    },

    async create(principal: SessionPrincipal, input: { workflowKey: string; name: string; definition: unknown }) {
      const definition = parseDefinition(input.definition);
      return deps.db.transaction(async (tx) => {
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
            attributes: { versionNumber, makeDefault: input.makeDefault },
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
