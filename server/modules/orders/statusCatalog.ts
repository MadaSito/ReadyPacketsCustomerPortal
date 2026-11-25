/**
 * Increment 07 (D2) — Admin-managed order status catalogue (`order_status_catalog`).
 *
 * Owner: recovery_ops_engineer (Package C).
 * Consumers:
 *  - orders_engineer (B): `getManyInTx(keys, tx)` for format-3 live labels, category and attention transitions
 *  - engagement_engineer (F): `listEntries()` for `automations.catalogue` status picker options
 *  - siem_engineer (G), ui_foundation_engineer (A): `trpc.orders.statusCatalog.list`
 *
 * Invariants:
 *  - Seeded idempotently on startup (and lazily on first access) from `BUILT_IN_STATUS_CATALOG` plus every
 *    status key in published `order_workflow_versions`. Existing rows are never overwritten by seeding.
 *  - Bidirectional cancel rule: `key.includes("cancel") <==> category === "canceled"`.
 *  - `key` is immutable once created. Renaming updates format-3 labels immediately while format-1/2 workflows
 *    keep their version-snapshot labels (`orders_engineer`).
 *  - Retiring is refused (`CONFLICT: STATUS_USED_BY_DRAFT`) while any open workflow draft references the key;
 *    existing orders in that status keep and display it.
 *  - Every privileged write runs `actorCheck(principal, tx, "orders.statuses.manage")` as the first statement
 *    inside the transaction (enforcing live session currency, admin role and fresh MFA step-up).
 */
import { asc, count, eq, inArray, sql } from "drizzle-orm";
import {
  BUILT_IN_STATUS_CATALOG,
  fallbackStatusCatalogLookup,
  validateStatusCancelCategoryRule,
  type OrderStatusAttention,
  type OrderStatusCategory,
  type OrderStatusTone,
  type StatusCatalogItem,
  type StatusCatalogLookup,
  type StatusCatalogUsage,
} from "../../../shared/orderStatusCatalog.js";
import { conflict, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { AuditEmitter, Clock, Db, DbOrTx, SessionPrincipal } from "../../core/types.js";
import type { ActorCheck } from "./actor.js";
import { orders, orderWorkflowDrafts, orderWorkflows, orderWorkflowVersions } from "./schema.js";
import { orderStatusCatalog, type OrderStatusCatalogRow } from "./statusCatalogSchema.js";
import type { WorkflowDraftDefinition } from "./workflowDesign.js";
import type { WorkflowDefinition, WorkflowState } from "./workflowTypes.js";

export interface StatusCatalogDeps {
  db: Db;
  clock: Clock;
  audit: AuditEmitter;
  /** In-tx actor re-validation (first statement of every admin write; locks no order row). */
  actorCheck: ActorCheck;
}

export interface CreateStatusCatalogInput {
  key: string;
  staffLabel: string;
  customerLabel: string;
  tone: OrderStatusTone;
  category: OrderStatusCategory;
  attention: OrderStatusAttention;
}

export interface UpdateStatusCatalogInput {
  key: string;
  expectedVersion: number;
  staffLabel: string;
  customerLabel: string;
  tone: OrderStatusTone;
  category: OrderStatusCategory;
  attention: OrderStatusAttention;
}

export interface AttentionCountsView {
  staffReview: number;
  customerResponse: number;
}

export interface OrderStatusCatalogService {
  /** Idempotent seed from `BUILT_IN_STATUS_CATALOG` + published `order_workflow_versions`. */
  ensureSeeded(tx?: DbOrTx): Promise<void>;
  /** Trusted internal port (used by `engagement` automations catalogue & internal callers). */
  listEntries(opts?: { includeRetired?: boolean; tx?: DbOrTx }): Promise<StatusCatalogItem[]>;
  /**
   * Trusted in-tx read port for `orders_engineer`: resolves status keys to `{ key, category, attention, staffLabel, customerLabel, tone, retired }`.
   * Missing keys fall back deterministically via `fallbackStatusCatalogLookup(key)` rather than failing old workflows.
   */
  getManyInTx(keys: readonly string[], tx?: DbOrTx): Promise<Map<string, StatusCatalogLookup>>;
  /** Single-key convenience wrapper around `getManyInTx`. */
  getOneInTx(key: string, tx?: DbOrTx): Promise<StatusCatalogLookup>;

  /* ---- Router-facing operations ---- */
  list(opts?: { includeRetired?: boolean; includeUsage?: boolean }): Promise<StatusCatalogItem[]>;
  attentionCounts(): Promise<AttentionCountsView>;
  create(principal: SessionPrincipal, input: CreateStatusCatalogInput): Promise<StatusCatalogItem>;
  update(principal: SessionPrincipal, input: UpdateStatusCatalogInput): Promise<StatusCatalogItem>;
  reorder(principal: SessionPrincipal, input: { orderedKeys: readonly string[] }): Promise<StatusCatalogItem[]>;
  retire(principal: SessionPrincipal, input: { key: string; expectedVersion: number }): Promise<StatusCatalogItem>;
  restore(principal: SessionPrincipal, input: { key: string; expectedVersion: number }): Promise<StatusCatalogItem>;
}

function rowToItem(row: OrderStatusCatalogRow, usage?: StatusCatalogUsage): StatusCatalogItem {
  return {
    publicId: row.publicId,
    key: row.key,
    staffLabel: row.staffLabel,
    customerLabel: row.customerLabel,
    tone: row.tone,
    category: row.category,
    attention: row.attention,
    position: row.position,
    retired: row.retired,
    retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
    version: row.version,
    ...(usage ? { usage } : {}),
  };
}

function rowToLookup(row: OrderStatusCatalogRow): StatusCatalogLookup {
  return {
    key: row.key,
    staffLabel: row.staffLabel,
    customerLabel: row.customerLabel,
    tone: row.tone,
    category: row.category,
    attention: row.attention,
    retired: row.retired,
  };
}

/** Derives a safe seed candidate for a custom status key found in a published workflow version. */
function deriveSeedFromWorkflowState(state: WorkflowState, position: number) {
  const derived = fallbackStatusCatalogLookup(state.key, {
    staffLabel: state.label.trim().slice(0, 60) || undefined,
    customerLabel: state.customerLabel.trim().slice(0, 60) || undefined,
    tone: state.tone,
    kind: state.kind,
  });

  return {
    key: derived.key,
    staffLabel: derived.staffLabel.slice(0, 60),
    customerLabel: derived.customerLabel.slice(0, 60),
    tone: derived.category === "canceled" && derived.tone === "success" ? ("neutral" as const) : derived.tone,
    category: derived.category,
    attention: derived.attention,
    position,
  };
}

/** Extracts every status key referenced anywhere inside an open workflow draft definition. */
export function collectDraftStatusKeys(definition: WorkflowDraftDefinition): Set<string> {
  const used = new Set<string>();
  for (const state of definition.states ?? []) {
    if (typeof state.key === "string" && state.key.trim().length > 0) {
      used.add(state.key.trim());
    }
  }
  for (const transition of definition.transitions ?? []) {
    if (typeof transition.from === "string" && transition.from.trim().length > 0) {
      used.add(transition.from.trim());
    }
    if (typeof transition.to === "string" && transition.to.trim().length > 0) {
      used.add(transition.to.trim());
    }
  }
  for (const gate of definition.acceptanceGates ?? []) {
    if (gate.point !== "order_start" && typeof gate.point?.stepKey === "string" && gate.point.stepKey.trim().length > 0) {
      used.add(gate.point.stepKey.trim());
    }
  }
  for (const rawStage of definition.stages ?? []) {
    if (!rawStage || typeof rawStage !== "object") continue;
    const stage = rawStage as Record<string, unknown>;
    if (Array.isArray(stage.statusKeys)) {
      for (const sk of stage.statusKeys) {
        if (typeof sk === "string" && sk.trim().length > 0) {
          used.add(sk.trim());
        }
      }
    }
    const stageActions = stage.stageActions;
    if (stageActions && typeof stageActions === "object") {
      const setStatusKey = (stageActions as Record<string, unknown>).setStatusKey;
      if (typeof setStatusKey === "string" && setStatusKey.trim().length > 0) {
        used.add(setStatusKey.trim());
      }
    }
  }
  return used;
}

function assertCancelCategoryRule(key: string, category: OrderStatusCategory): void {
  const err = validateStatusCancelCategoryRule(key, category);
  if (err) {
    throw validation("CANCEL_KEY_CATEGORY_MISMATCH", err);
  }
}

export function createOrderStatusCatalogService(deps: StatusCatalogDeps): OrderStatusCatalogService {
  let seeded = false;
  let seedInFlight: Promise<void> | null = null;

  async function runSeed(conn: DbOrTx): Promise<void> {
    const existingRows = await conn
      .select({ key: orderStatusCatalog.key, position: orderStatusCatalog.position })
      .from(orderStatusCatalog);
    const existingKeys = new Set(existingRows.map((r) => r.key));
    let nextPos = existingRows.length > 0 ? Math.max(...existingRows.map((r) => r.position)) + 1 : 0;

    const candidates: {
      key: string;
      staffLabel: string;
      customerLabel: string;
      tone: OrderStatusTone;
      category: OrderStatusCategory;
      attention: OrderStatusAttention;
      position: number;
    }[] = [];
    const seenCandidateKeys = new Set<string>(existingKeys);

    for (const builtIn of BUILT_IN_STATUS_CATALOG) {
      if (seenCandidateKeys.has(builtIn.key)) continue;
      seenCandidateKeys.add(builtIn.key);
      const pos = Math.max(builtIn.position, nextPos);
      nextPos = pos + 1;
      candidates.push({
        key: builtIn.key,
        staffLabel: builtIn.staffLabel,
        customerLabel: builtIn.customerLabel,
        tone: builtIn.tone,
        category: builtIn.category,
        attention: builtIn.attention,
        position: pos,
      });
    }

    const publishedVersions = await conn
      .select({ definition: orderWorkflowVersions.definition })
      .from(orderWorkflowVersions)
      .orderBy(asc(orderWorkflowVersions.id))
      .limit(2000);

    for (const row of publishedVersions) {
      const def = row.definition as WorkflowDefinition | null;
      if (!def || !Array.isArray(def.states)) continue;
      for (const state of def.states) {
        if (!state || typeof state.key !== "string" || state.key.length < 2 || state.key.length > 48) continue;
        if (seenCandidateKeys.has(state.key)) continue;
        seenCandidateKeys.add(state.key);
        const pos = nextPos;
        nextPos += 1;
        candidates.push(deriveSeedFromWorkflowState(state, pos));
      }
    }

    if (candidates.length === 0) return;

    const nowMs = deps.clock.now().getTime();
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i]!;
      await conn
        .insert(orderStatusCatalog)
        .values({
          publicId: ulid(nowMs + i),
          key: candidate.key,
          staffLabel: candidate.staffLabel,
          customerLabel: candidate.customerLabel,
          tone: candidate.tone,
          category: candidate.category,
          attention: candidate.attention,
          position: candidate.position,
          retired: false,
          retiredAt: null,
        })
        // Never overwrite an existing row on concurrent startup race.
        .onDuplicateKeyUpdate({ set: { id: sql`id` } });
    }
  }

  async function ensureSeeded(tx?: DbOrTx): Promise<void> {
    if (tx) {
      await runSeed(tx);
      return;
    }
    if (seeded) return;
    if (!seedInFlight) {
      seedInFlight = runSeed(deps.db)
        .then(() => {
          seeded = true;
        })
        .finally(() => {
          seedInFlight = null;
        });
    }
    await seedInFlight;
  }

  async function computeUsageMap(conn: DbOrTx): Promise<Map<string, StatusCatalogUsage>> {
    const usageByKey = new Map<string, StatusCatalogUsage>();
    const ensureEntry = (key: string): StatusCatalogUsage => {
      let u = usageByKey.get(key);
      if (!u) {
        u = { activeOrderCount: 0, draftCount: 0, publishedVersionCount: 0 };
        usageByKey.set(key, u);
      }
      return u;
    };

    const [draftRows, activeWorkflowRows, orderGroupRows] = await Promise.all([
      conn
        .select({ definition: orderWorkflowDrafts.definition })
        .from(orderWorkflowDrafts)
        .orderBy(asc(orderWorkflowDrafts.id))
        .limit(500),
      conn
        .select({ workflowId: orderWorkflows.id, definition: orderWorkflowVersions.definition })
        .from(orderWorkflows)
        .innerJoin(orderWorkflowVersions, eq(orderWorkflowVersions.id, orderWorkflows.currentVersionId))
        .limit(500),
      conn
        .select({ statusKey: orders.statusKey, total: count() })
        .from(orders)
        .groupBy(orders.statusKey),
    ]);

    for (const draft of draftRows) {
      const keys = collectDraftStatusKeys(draft.definition);
      for (const k of keys) {
        ensureEntry(k).draftCount += 1;
      }
    }

    for (const wf of activeWorkflowRows) {
      const def = wf.definition as WorkflowDefinition | null;
      if (!def || !Array.isArray(def.states)) continue;
      const seenInWf = new Set<string>();
      for (const state of def.states) {
        if (state && typeof state.key === "string" && !seenInWf.has(state.key)) {
          seenInWf.add(state.key);
          ensureEntry(state.key).publishedVersionCount += 1;
        }
      }
    }

    for (const group of orderGroupRows) {
      ensureEntry(group.statusKey).activeOrderCount = Number(group.total ?? 0);
    }

    return usageByKey;
  }

  async function listInternal(
    conn: DbOrTx,
    opts?: { includeRetired?: boolean; includeUsage?: boolean },
  ): Promise<StatusCatalogItem[]> {
    const includeRetired = opts?.includeRetired ?? false;
    const rows = await conn
      .select()
      .from(orderStatusCatalog)
      .where(includeRetired ? undefined : eq(orderStatusCatalog.retired, false))
      .orderBy(asc(orderStatusCatalog.position), asc(orderStatusCatalog.id))
      .limit(500);

    if (!opts?.includeUsage) {
      return rows.map((r) => rowToItem(r));
    }

    const usageMap = await computeUsageMap(conn);
    return rows.map((r) =>
      rowToItem(
        r,
        usageMap.get(r.key) ?? {
          activeOrderCount: 0,
          draftCount: 0,
          publishedVersionCount: 0,
        },
      ),
    );
  }

  return {
    ensureSeeded,

    async listEntries(opts) {
      if (opts?.tx) {
        if (!seeded) await ensureSeeded(opts.tx);
        return listInternal(opts.tx, { includeRetired: opts.includeRetired ?? false });
      }
      await ensureSeeded();
      return listInternal(deps.db, { includeRetired: opts?.includeRetired ?? false });
    },

    async getManyInTx(keys, tx) {
      const uniqueKeys = Array.from(new Set(keys.filter((k) => typeof k === "string" && k.length > 0)));
      const map = new Map<string, StatusCatalogLookup>();
      if (uniqueKeys.length === 0) return map;

      const conn = tx ?? deps.db;
      if (!seeded) {
        await ensureSeeded(tx);
      }

      const rows = await conn
        .select()
        .from(orderStatusCatalog)
        .where(inArray(orderStatusCatalog.key, uniqueKeys));

      for (const row of rows) {
        map.set(row.key, rowToLookup(row));
      }
      for (const key of uniqueKeys) {
        if (!map.has(key)) {
          map.set(key, fallbackStatusCatalogLookup(key));
        }
      }
      return map;
    },

    async getOneInTx(key, tx) {
      const map = await this.getManyInTx([key], tx);
      return map.get(key) ?? fallbackStatusCatalogLookup(key);
    },

    async list(opts) {
      await ensureSeeded();
      return listInternal(deps.db, opts);
    },

    async attentionCounts() {
      const grouped = await deps.db
        .select({
          attention: orders.attention,
          total: count(),
        })
        .from(orders)
        .where(inArray(orders.attention, ["staff_review", "customer_response"]))
        .groupBy(orders.attention);

      let staffReview = 0;
      let customerResponse = 0;
      for (const row of grouped) {
        if (row.attention === "staff_review") {
          staffReview = Number(row.total ?? 0);
        } else if (row.attention === "customer_response") {
          customerResponse = Number(row.total ?? 0);
        }
      }
      return { staffReview, customerResponse };
    },

    async create(principal, input) {
      await ensureSeeded();
      const normalizedKey = input.key.trim();
      const staffLabel = input.staffLabel.trim().normalize("NFC");
      const customerLabel = input.customerLabel.trim().normalize("NFC");
      assertCancelCategoryRule(normalizedKey, input.category);

      return deps.db.transaction(async (tx) => {
        await deps.actorCheck(principal, tx, "orders.statuses.manage");

        const [existing] = await tx
          .select({ id: orderStatusCatalog.id })
          .from(orderStatusCatalog)
          .where(eq(orderStatusCatalog.key, normalizedKey))
          .for("update")
          .limit(1);
        if (existing) {
          throw conflict("STATUS_KEY_TAKEN", "A status with that key already exists.");
        }

        const [maxRow] = await tx
          .select({ maxPos: sql<number>`COALESCE(MAX(${orderStatusCatalog.position}), -1)` })
          .from(orderStatusCatalog);
        const position = Number(maxRow?.maxPos ?? -1) + 1;
        const publicId = ulid(deps.clock.now().getTime());

        await tx.insert(orderStatusCatalog).values({
          publicId,
          key: normalizedKey,
          staffLabel,
          customerLabel,
          tone: input.tone,
          category: input.category,
          attention: input.attention,
          position,
          retired: false,
          retiredAt: null,
        });

        const [created] = await tx
          .select()
          .from(orderStatusCatalog)
          .where(eq(orderStatusCatalog.publicId, publicId))
          .limit(1);

        await deps.audit.record(
          {
            category: "admin",
            eventName: "order.status_catalog.created",
            action: "create",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "order_status_catalog", publicId },
            attributes: {
              status_key: normalizedKey,
              status_category: input.category,
              status_tone: input.tone,
              status_attention: input.attention,
              version: 1,
            },
          },
          tx,
        );

        return rowToItem(created!);
      });
    },

    async update(principal, input) {
      await ensureSeeded();
      const normalizedKey = input.key.trim();
      const staffLabel = input.staffLabel.trim().normalize("NFC");
      const customerLabel = input.customerLabel.trim().normalize("NFC");
      assertCancelCategoryRule(normalizedKey, input.category);

      return deps.db.transaction(async (tx) => {
        await deps.actorCheck(principal, tx, "orders.statuses.manage");

        const [row] = await tx
          .select()
          .from(orderStatusCatalog)
          .where(eq(orderStatusCatalog.key, normalizedKey))
          .for("update")
          .limit(1);
        if (!row) {
          throw notFound("STATUS_NOT_FOUND");
        }
        if (row.version !== input.expectedVersion) {
          throw conflict("VERSION_CONFLICT", "This status was updated by another administrator. Reload and try again.");
        }

        const nextVersion = row.version + 1;
        await tx
          .update(orderStatusCatalog)
          .set({
            staffLabel,
            customerLabel,
            tone: input.tone,
            category: input.category,
            attention: input.attention,
            version: nextVersion,
          })
          .where(eq(orderStatusCatalog.id, row.id));

        const [updated] = await tx
          .select()
          .from(orderStatusCatalog)
          .where(eq(orderStatusCatalog.id, row.id))
          .limit(1);

        await deps.audit.record(
          {
            category: "admin",
            eventName: "order.status_catalog.updated",
            action: "update",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "order_status_catalog", publicId: row.publicId },
            attributes: {
              status_key: row.key,
              status_category: input.category,
              status_tone: input.tone,
              status_attention: input.attention,
              version: nextVersion,
            },
          },
          tx,
        );

        return rowToItem(updated!);
      });
    },

    async reorder(principal, input) {
      await ensureSeeded();
      const orderedKeys = input.orderedKeys.map((k) => k.trim());
      if (orderedKeys.length === 0) {
        throw validation("EMPTY_STATUS_ORDER", "Provide at least one status key to reorder.");
      }
      if (new Set(orderedKeys).size !== orderedKeys.length) {
        throw validation("DUPLICATE_STATUS_KEY", "Each status key may appear at most once when reordering.");
      }

      return deps.db.transaction(async (tx) => {
        await deps.actorCheck(principal, tx, "orders.statuses.manage");

        const rows = await tx
          .select()
          .from(orderStatusCatalog)
          .orderBy(asc(orderStatusCatalog.id))
          .for("update");

        const byKey = new Map(rows.map((r) => [r.key, r]));
        for (const key of orderedKeys) {
          if (!byKey.has(key)) {
            throw notFound("STATUS_NOT_FOUND");
          }
        }

        const passedSet = new Set(orderedKeys);
        for (const row of rows) {
          if (!row.retired && !passedSet.has(row.key)) {
            throw validation(
              "INCOMPLETE_STATUS_ORDER",
              "All active statuses must be included when reordering the catalogue.",
            );
          }
        }

        // Preserve relative order of any omitted retired statuses after the explicitly ordered keys.
        const remainingRetired = rows
          .filter((r) => !passedSet.has(r.key))
          .sort((a, b) => a.position - b.position || a.id - b.id);
        const finalSequence = [
          ...orderedKeys.map((k) => byKey.get(k)!),
          ...remainingRetired,
        ];

        for (let idx = 0; idx < finalSequence.length; idx += 1) {
          const row = finalSequence[idx]!;
          if (row.position !== idx) {
            await tx
              .update(orderStatusCatalog)
              .set({
                position: idx,
                version: row.version + 1,
              })
              .where(eq(orderStatusCatalog.id, row.id));
          }
        }

        await deps.audit.record(
          {
            category: "admin",
            eventName: "order.status_catalog.reordered",
            action: "reorder",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "order_status_catalog" },
            attributes: {
              status_count: orderedKeys.length,
            },
          },
          tx,
        );

        return listInternal(tx, { includeRetired: true, includeUsage: true });
      });
    },

    async retire(principal, input) {
      await ensureSeeded();
      const normalizedKey = input.key.trim();

      return deps.db.transaction(async (tx) => {
        await deps.actorCheck(principal, tx, "orders.statuses.manage");

        const [row] = await tx
          .select()
          .from(orderStatusCatalog)
          .where(eq(orderStatusCatalog.key, normalizedKey))
          .for("update")
          .limit(1);
        if (!row) {
          throw notFound("STATUS_NOT_FOUND");
        }
        if (row.version !== input.expectedVersion) {
          throw conflict("VERSION_CONFLICT", "This status was updated by another administrator. Reload and try again.");
        }
        if (row.retired) {
          return rowToItem(row);
        }

        // Refuse retiring while any open workflow draft references this status key.
        const drafts = await tx
          .select({ name: orderWorkflowDrafts.name, definition: orderWorkflowDrafts.definition })
          .from(orderWorkflowDrafts)
          .orderBy(asc(orderWorkflowDrafts.id))
          .for("share")
          .limit(500);

        const blockingDrafts: string[] = [];
        for (const draft of drafts) {
          if (collectDraftStatusKeys(draft.definition).has(normalizedKey)) {
            blockingDrafts.push(draft.name);
          }
        }
        if (blockingDrafts.length > 0) {
          const names = blockingDrafts.slice(0, 3).join(", ");
          throw conflict(
            "STATUS_USED_BY_DRAFT",
            `Cannot retire "${row.staffLabel}" while it is used by an open workflow draft (${names}). Remove it from the draft or publish/discard the draft first.`,
          );
        }

        const retiredAt = deps.clock.now();
        const nextVersion = row.version + 1;
        await tx
          .update(orderStatusCatalog)
          .set({
            retired: true,
            retiredAt,
            version: nextVersion,
          })
          .where(eq(orderStatusCatalog.id, row.id));

        const [updated] = await tx
          .select()
          .from(orderStatusCatalog)
          .where(eq(orderStatusCatalog.id, row.id))
          .limit(1);

        await deps.audit.record(
          {
            category: "admin",
            eventName: "order.status_catalog.retired",
            action: "retire",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "order_status_catalog", publicId: row.publicId },
            attributes: {
              status_key: row.key,
              version: nextVersion,
            },
          },
          tx,
        );

        return rowToItem(updated!);
      });
    },

    async restore(principal, input) {
      await ensureSeeded();
      const normalizedKey = input.key.trim();

      return deps.db.transaction(async (tx) => {
        await deps.actorCheck(principal, tx, "orders.statuses.manage");

        const [row] = await tx
          .select()
          .from(orderStatusCatalog)
          .where(eq(orderStatusCatalog.key, normalizedKey))
          .for("update")
          .limit(1);
        if (!row) {
          throw notFound("STATUS_NOT_FOUND");
        }
        if (row.version !== input.expectedVersion) {
          throw conflict("VERSION_CONFLICT", "This status was updated by another administrator. Reload and try again.");
        }
        if (!row.retired) {
          return rowToItem(row);
        }

        const nextVersion = row.version + 1;
        await tx
          .update(orderStatusCatalog)
          .set({
            retired: false,
            retiredAt: null,
            version: nextVersion,
          })
          .where(eq(orderStatusCatalog.id, row.id));

        const [updated] = await tx
          .select()
          .from(orderStatusCatalog)
          .where(eq(orderStatusCatalog.id, row.id))
          .limit(1);

        await deps.audit.record(
          {
            category: "admin",
            eventName: "order.status_catalog.restored",
            action: "restore",
            outcome: "completed",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "order_status_catalog", publicId: row.publicId },
            attributes: {
              status_key: row.key,
              version: nextVersion,
            },
          },
          tx,
        );

        return rowToItem(updated!);
      });
    },
  };
}
