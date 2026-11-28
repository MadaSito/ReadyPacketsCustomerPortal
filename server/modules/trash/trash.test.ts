/**
 * Scoped tests for `server/modules/trash` (Increment 09, Decision D2 & D2.8). Owner: recovery_ops_engineer.
 *
 * Uses synthetic fixtures only (`Zeus Greene`, `RPCUS-A1B2CJJG5`, project `Ice Queen`).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDeps, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { SessionPrincipal } from "../../core/types.js";
import { createCallerFactory, router } from "../../trpc/trpc.js";
import { createIdentityModule } from "../identity/index.js";
import {
  identityTokens,
  sessionRestrictions,
  signInEvents,
  ssoAuthRequests,
  ssoConfiguration,
  ssoIdentities,
  userSessions,
  users,
} from "../identity/schema.js";
import { nameColumns, emailColumns } from "../identity/users.js";
import { orderAdminTasks, orderQuestionAnswers, orderQuestions } from "../orders/questionsSchema.js";
import {
  orderAcknowledgements,
  orderGrants,
  orderLineItems,
  orderLockHistory,
  orderNameHistory,
  orderNotes,
  orderPhaseLocks,
  orderStageProgress,
  orderStatusHistory,
  orderTaskNotes,
  orderTaskWaivers,
  orders,
} from "../orders/schema.js";
import { createOrderTrash } from "../orders/trash.js";
import { platformSettings } from "../platform/schema.js";
import { createTrashModule, type TrashCoordinatorModule } from "./index.js";
import type { TrashEntityRef, TrashParticipant, TrashPurgeResult, TrashPurgeRun } from "./ports.js";
import { trashRouter } from "./router.js";
import {
  trashCleanupSweeps,
  trashIdempotencyKeys,
  trashPurgeRuns,
  trashRetentionState,
} from "./schema.js";
import {
  TRASH_AUTO_PURGE_ENABLED,
  TRASH_RETENTION_CUSTOMER_DAYS,
  TRASH_RETENTION_DEFAULT_DAYS,
  TRASH_RETENTION_ORDER_DAYS,
} from "./settings.js";

const schema = {
  users,
  userSessions,
  identityTokens,
  ssoConfiguration,
  ssoIdentities,
  ssoAuthRequests,
  signInEvents,
  sessionRestrictions,
  orders,
  orderLineItems,
  orderStatusHistory,
  orderNameHistory,
  orderLockHistory,
  orderNotes,
  orderGrants,
  orderStageProgress,
  orderPhaseLocks,
  orderAcknowledgements,
  orderTaskNotes,
  orderTaskWaivers,
  orderQuestions,
  orderQuestionAnswers,
  orderAdminTasks,
  platformSettings,
  trashPurgeRuns,
  trashCleanupSweeps,
  trashIdempotencyKeys,
  trashRetentionState,
};

let t: TestDb;
let h: TestHarness;
let trash: TrashCoordinatorModule;
let adminPrincipal: SessionPrincipal;
let adminStepUpPrincipal: SessionPrincipal;
let adminPublicId: string;
let opsEmitted: { code: string; dedupKey: string; severity: string }[];

const appRouter = router({ trash: trashRouter });
const makeCaller = createCallerFactory(appRouter);

beforeAll(async () => {
  t = await createTestDb({ schema });
});

afterAll(() => {
  t?.cleanup();
});

beforeEach(async () => {
  for (const table of [...Object.values(schema)].reverse()) {
    await t.db.delete(table);
  }
  h = createTestDeps({ db: t.db });
  opsEmitted = [];

  h.services.opsAlerts = {
    emit: async (input: { code: string; dedupKey: string; severity: string }) => {
      opsEmitted.push({ code: input.code, dedupKey: input.dedupKey, severity: input.severity });
    },
    resolve: async () => true,
  } as never;

  h.services.assurance = {
    getAssuranceState: async () => ({
      mfaEnrolled: true,
      recoveryCodesAcknowledged: true,
    }),
  } as never;

  const identity = createIdentityModule(h.deps);
  h.services.identity = identity;

  const orderTrash = createOrderTrash({
    db: t.db,
    clock: h.clock,
    services: h.services,
    workflows: { byVersionId: async () => ({ definition: { states: [] } }) as never },
  });
  h.services.orders = {
    trash: orderTrash,
  } as never;

  trash = createTrashModule(h.deps, {
    expectedParticipants: ["identity", "orders", "files"],
  });
  h.services.trash = trash;

  identity.init?.();
  trash.register(orderTrash.participant);
  trash.register({
    module: "files",
    summarize: async () => ({ files: 2 }),
    purge: async () => ({ deleted: { files: 2 } }),
  });
  trash.init?.();

  const now = h.clock.now();
  adminPublicId = ulid(now.getTime());
  const baseSessPublicId = ulid(now.getTime() + 1);
  const stepUpSessPublicId = ulid(now.getTime() + 2);
  await t.db.insert(users).values({
    id: 1,
    publicId: adminPublicId,
    role: "admin",
    status: "active",
    emailVerifiedAt: now,
    ...emailColumns(h.deps.crypto, adminPublicId, "admin@synthetic.invalid"),
    ...nameColumns(h.deps.crypto, adminPublicId, "Admin Operator"),
  });

  const csrf1 = "csrf-secret-1";
  const csrf2 = "csrf-secret-2";
  await t.db.insert(userSessions).values([
    {
      publicId: baseSessPublicId,
      userId: 1,
      tokenHash: "1".repeat(64),
      csrfSecretEnc: h.deps.crypto.encrypt(csrf1, `user_sessions.csrf:${baseSessPublicId}`),
      authMethod: "local",
      authenticatedAt: now,
      mfaVerifiedAt: now,
      stepUpAt: null,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: new Date(now.getTime() + 60 * 86_400_000),
    },
    {
      publicId: stepUpSessPublicId,
      userId: 1,
      tokenHash: "2".repeat(64),
      csrfSecretEnc: h.deps.crypto.encrypt(csrf2, `user_sessions.csrf:${stepUpSessPublicId}`),
      authMethod: "local",
      authenticatedAt: now,
      mfaVerifiedAt: now,
      stepUpAt: now,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: new Date(now.getTime() + 60 * 86_400_000),
    },
  ]);

  adminPrincipal = {
    sessionId: baseSessPublicId,
    userId: 1,
    userPublicId: adminPublicId,
    role: "admin",
    state: "full",
    pendingSteps: [],
    authMethod: "local",
    authenticatedAt: now,
    mfaVerifiedAt: now,
    stepUpAt: null,
    csrfSecret: csrf1,
  };
  adminStepUpPrincipal = {
    ...adminPrincipal,
    sessionId: stepUpSessPublicId,
    csrfSecret: csrf2,
    stepUpAt: now,
  };
});

async function seedCustomer(opts: {
  id: number;
  status?: "active" | "suspended";
  customerRef?: string;
  first?: string;
  last?: string;
}) {
  const publicId = ulid();
  const customerRef = opts.customerRef ?? "RPCUS-A1B2CJJG5";
  await t.db.insert(users).values({
    id: opts.id,
    publicId,
    customerRef,
    role: "customer",
    status: opts.status ?? "suspended",
    ...emailColumns(h.deps.crypto, publicId, `zeus.${opts.id}@synthetic.invalid`),
    ...nameColumns(
      h.deps.crypto,
      publicId,
      `${opts.first ?? "Zeus"} ${opts.last ?? "Greene"}`,
    ),
  });
  return { id: opts.id, publicId, customerRef };
}

async function seedOrder(opts: {
  id: number;
  ownerUserId: number;
  reference: string;
  projectName?: string;
  groupRootOrderId?: number | null;
  lockState?: "none" | "review" | "finalized" | "legal_hold" | "imported_read_only";
}) {
  const publicId = ulid();
  await t.db.insert(orders).values({
    id: opts.id,
    publicId,
    reference: opts.reference,
    ownerUserId: opts.ownerUserId,
    projectName: opts.projectName ?? "Ice Queen",
    groupRootOrderId: opts.groupRootOrderId ?? null,
    lockState: opts.lockState ?? "none",
    workflowVersionId: 1,
    statusKey: "intake",
    subtotalMinor: 1000,
    totalMinor: 1000,
    currency: "USD",
  });
  return { id: opts.id, publicId, reference: opts.reference };
}

describe("trash settings registration", () => {
  it("marks trash.auto_purge_enabled ownerWriteOnly and non-exportable with 30-day defaults", () => {
    expect(TRASH_AUTO_PURGE_ENABLED.ownerWriteOnly).toBe(true);
    expect(TRASH_AUTO_PURGE_ENABLED.exportable).toBe(false);
    expect(TRASH_RETENTION_ORDER_DAYS.ownerWriteOnly).toBe(true);
    expect(TRASH_RETENTION_CUSTOMER_DAYS.ownerWriteOnly).toBe(true);
    expect(TRASH_RETENTION_DEFAULT_DAYS).toBe(30);
  });
});

describe("moveToTrash & restore invariants", () => {
  it("trashes a root order with its group addition, sanitizes reason, and never logs raw reason in audit", async () => {
    const cust = await seedCustomer({ id: 10, status: "active" });
    const root = await seedOrder({ id: 100, ownerUserId: cust.id, reference: "ORD-2026-0100" });
    const child = await seedOrder({
      id: 101,
      ownerUserId: cust.id,
      reference: "ORD-2026-0101",
      groupRootOrderId: root.id,
    });

    const rawSecretNote = "Zeus Greene requested cancellation via phone 555-0100";
    const res = await trash.moveToTrash(adminPrincipal, {
      kind: "order",
      publicId: root.publicId,
      reason: `  ${rawSecretNote}\u0007  `,
      idempotencyKey: "idem-move-root-01",
    });

    expect(res.cascadedOrders).toBe(1);
    const trashedEvents = h.audit.named("order.trashed");
    expect(trashedEvents).toHaveLength(2);
    for (const ev of trashedEvents) {
      expect(ev.attributes).toMatchObject({ reason_present: true, trash_batch_id: res.batchId });
      expect(JSON.stringify(ev)).not.toContain("Zeus");
      expect(JSON.stringify(ev)).not.toContain("555-0100");
    }

    // Restoring addition before root is vetoed with ROOT_IN_TRASH
    await expect(
      trash.restore(adminPrincipal, {
        items: [{ kind: "order", publicId: child.publicId, batchId: res.batchId }],
        idempotencyKey: "idem-restore-child-first",
      }),
    ).rejects.toMatchObject({ reasonCode: "ROOT_IN_TRASH" });

    // Restoring root restores the root cleanly
    const restored = await trash.restore(adminPrincipal, {
      items: [{ kind: "order", publicId: root.publicId, batchId: res.batchId }],
      idempotencyKey: "idem-restore-root-ok",
    });
    expect(restored.results[0]?.ok).toBe(true);
  });

  it("requires customer to be suspended before trashing, cascades orders, and blocks order restore while owner is trashed", async () => {
    const activeCust = await seedCustomer({ id: 20, status: "active", customerRef: "RPCUS-ACTV00001" });
    await expect(
      trash.moveToTrash(adminPrincipal, {
        kind: "customer",
        publicId: activeCust.publicId,
        idempotencyKey: "idem-active-cust-refused",
      }),
    ).rejects.toMatchObject({ reasonCode: "CUSTOMER_NOT_SUSPENDED" });

    const suspCust = await seedCustomer({ id: 21, status: "suspended", customerRef: "RPCUS-A1B2CJJG5" });
    const ord = await seedOrder({ id: 201, ownerUserId: suspCust.id, reference: "ORD-2026-0201" });

    const moved = await trash.moveToTrash(adminPrincipal, {
      kind: "customer",
      publicId: suspCust.publicId,
      idempotencyKey: "idem-susp-cust-move",
    });
    expect(moved.cascadedOrders).toBe(1);

    // Order cannot be restored alone while its customer owner is in trash
    await expect(
      trash.restore(adminPrincipal, {
        items: [{ kind: "order", publicId: ord.publicId, batchId: moved.batchId }],
        idempotencyKey: "idem-restore-ord-owner-trashed",
      }),
    ).rejects.toMatchObject({ reasonCode: "OWNER_IN_TRASH" });

    // Restoring customer restores same-batch orders and keeps customer status suspended
    const restoredCust = await trash.restore(adminPrincipal, {
      items: [{ kind: "customer", publicId: suspCust.publicId, batchId: moved.batchId }],
      idempotencyKey: "idem-restore-cust-cascade",
    });
    expect(restoredCust.results[0]?.ok).toBe(true);
    const [custAfter] = await t.db.select().from(users).where(eq(users.id, suspCust.id));
    expect(custAfter?.status).toBe("suspended");
    expect(custAfter?.trashedAt).toBeNull();
    const [ordAfter] = await t.db.select().from(orders).where(eq(orders.id, ord.id));
    expect(ordAfter?.trashedAt).toBeNull();
  });
});

describe("legal hold veto across trash, customer cascade, purge, and retention", () => {
  it("blocks trashing or purging a held order or its customer, and skips held trashed orders in retention sweep", async () => {
    const cust = await seedCustomer({ id: 30, status: "suspended" });
    const heldOrder = await seedOrder({
      id: 300,
      ownerUserId: cust.id,
      reference: "ORD-2026-0300",
      lockState: "legal_hold",
    });

    await expect(
      trash.moveToTrash(adminPrincipal, {
        kind: "order",
        publicId: heldOrder.publicId,
        idempotencyKey: "idem-hold-order-trash",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "ORDER_ON_LEGAL_HOLD",
      safeMessage: "Release the legal hold first.",
    });

    await expect(
      trash.moveToTrash(adminPrincipal, {
        kind: "customer",
        publicId: cust.publicId,
        idempotencyKey: "idem-hold-cust-trash",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "ORDER_ON_LEGAL_HOLD",
      safeMessage: "Release the legal hold first.",
    });

    // Unlock, move order to trash, then place legal hold while in trash
    await t.db.update(orders).set({ lockState: "none" }).where(eq(orders.id, heldOrder.id));
    const moved = await trash.moveToTrash(adminPrincipal, {
      kind: "order",
      publicId: heldOrder.publicId,
      idempotencyKey: "idem-unlocked-order-trash",
    });
    await t.db.update(orders).set({ lockState: "legal_hold" }).where(eq(orders.id, heldOrder.id));

    await expect(
      trash.purge(adminStepUpPrincipal, {
        items: [{ kind: "order", publicId: heldOrder.publicId, batchId: moved.batchId }],
        confirmation: heldOrder.reference,
        idempotencyKey: "idem-hold-order-purge",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "ORDER_ON_LEGAL_HOLD",
    });

    // Advance clock past 30-day retention; retention sweep skips held order & emits ORDER_ON_LEGAL_HOLD alert without tombstoning
    h.clock.advance(31 * 86_400_000);
    const sweep = await trash.runRetentionCleanup("job-hold-sweep");
    expect(sweep.failed).toBe(0);
    expect(sweep.purged).toBe(0);
    const [stillInTrash] = await t.db.select().from(orders).where(eq(orders.id, heldOrder.id));
    expect(stillInTrash?.purgedAt).toBeNull();
    expect(stillInTrash?.trashedAt).not.toBeNull();
    expect(opsEmitted.some((a) => a.code === "ORDER_ON_LEGAL_HOLD")).toBe(true);
  });
});

describe("resumable fenced purge, fail-closed participant manifest, and unreachable external-copy gate", () => {
  it("fails closed when an expected participant is missing from the registry", async () => {
    const cust = await seedCustomer({ id: 40, status: "active" });
    const ord = await seedOrder({ id: 400, ownerUserId: cust.id, reference: "ORD-2026-0400" });

    const incompleteTrash = createTrashModule(h.deps, {
      expectedParticipants: ["identity", "orders", "files", "payments"],
    });
    for (const p of trash.participants()) incompleteTrash.register(p);
    incompleteTrash.init?.();

    const moved = await incompleteTrash.moveToTrash(adminPrincipal, {
      kind: "order",
      publicId: ord.publicId,
      idempotencyKey: "idem-incomplete-move",
    });

    await expect(
      incompleteTrash.purge(adminStepUpPrincipal, {
        items: [{ kind: "order", publicId: ord.publicId, batchId: moved.batchId }],
        confirmation: ord.reference,
        idempotencyKey: "idem-incomplete-purge",
      }),
    ).rejects.toMatchObject({ reasonCode: "TRASH_PARTICIPANT_MISSING" });
  });

  it("checkpoints participant completion on failure and resumes without re-running completed participants", async () => {
    const cust = await seedCustomer({ id: 41, status: "active" });
    const ord = await seedOrder({ id: 401, ownerUserId: cust.id, reference: "ORD-2026-0401" });

    let flakyCalls = 0;
    const earlyCalls = vi.fn(async (): Promise<TrashPurgeResult> => ({ deleted: { earlyRows: 3 } }));
    const flakyParticipant: TrashParticipant = {
      module: "flaky",
      purge: async () => {
        flakyCalls += 1;
        if (flakyCalls === 1) {
          throw new DomainError("UNAVAILABLE", "SYNTHETIC_PARTICIPANT_DOWN", "Temporary downstream outage.");
        }
        return { deleted: { flakyRows: 1 } };
      },
    };

    const resumableTrash = createTrashModule(h.deps, {
      expectedParticipants: ["identity", "orders", "early", "flaky"],
    });
    for (const p of trash.participants()) {
      if (p.module === "identity" || p.module === "orders") resumableTrash.register(p);
    }
    resumableTrash.register({ module: "early", purge: earlyCalls });
    resumableTrash.register(flakyParticipant);
    resumableTrash.init?.();

    const moved = await resumableTrash.moveToTrash(adminPrincipal, {
      kind: "order",
      publicId: ord.publicId,
      idempotencyKey: "idem-resume-move",
    });

    await expect(
      resumableTrash.purge(adminStepUpPrincipal, {
        items: [{ kind: "order", publicId: ord.publicId, batchId: moved.batchId }],
        confirmation: ord.reference,
        idempotencyKey: "idem-resume-purge-1",
      }),
    ).rejects.toMatchObject({ reasonCode: "SYNTHETIC_PARTICIPANT_DOWN" });

    expect(earlyCalls).toHaveBeenCalledTimes(1);

    // Purge is in progress: restore must be vetoed
    await expect(
      resumableTrash.restore(adminPrincipal, {
        items: [{ kind: "order", publicId: ord.publicId, batchId: moved.batchId }],
        idempotencyKey: "idem-restore-during-purge",
      }),
    ).rejects.toMatchObject({ reasonCode: "PURGE_IN_PROGRESS" });

    // Second attempt resumes from checkpoint: `early` is NOT called again!
    const completed = await resumableTrash.purge(adminStepUpPrincipal, {
      items: [{ kind: "order", publicId: ord.publicId, batchId: moved.batchId }],
      confirmation: ord.reference,
      idempotencyKey: "idem-resume-purge-2",
    });
    expect(completed.results[0]?.ok).toBe(true);
    expect(earlyCalls).toHaveBeenCalledTimes(1);
    expect(flakyCalls).toBe(2);

    const [tombstoned] = await t.db.select().from(orders).where(eq(orders.id, ord.id));
    expect(tombstoned?.purgedAt).not.toBeNull();
    expect(tombstoned?.projectName).toBe("Deleted order");
  });

  it("enforces single-order typed acknowledgment for EXTERNAL_COPIES_UNREACHABLE and never forwards it in retention", async () => {
    const cust = await seedCustomer({ id: 42, status: "active" });
    const ord = await seedOrder({ id: 402, ownerUserId: cust.id, reference: "ORD-2026-0402" });
    const connPubId = ulid();

    const seenAckFlags: boolean[] = [];
    const extTrash = createTrashModule(h.deps, {
      expectedParticipants: ["identity", "orders", "files"],
    });
    for (const p of trash.participants()) {
      if (p.module === "identity" || p.module === "orders") extTrash.register(p);
    }
    extTrash.register({
      module: "files",
      purge: async (_entity: TrashEntityRef, run: TrashPurgeRun): Promise<TrashPurgeResult> => {
        seenAckFlags.push(Boolean(run.acknowledgedUnreachableCopies));
        if (!run.acknowledgedUnreachableCopies) {
          throw new DomainError(
            "UNAVAILABLE",
            "EXTERNAL_COPIES_UNREACHABLE",
            "External storage destination is unreachable.",
            {
              unreachableCopies: 2,
              unreachableCopyCounts: [`${connPubId}:2`],
            },
          );
        }
        return {
          deleted: { files: 1 },
          kept: { acknowledgedExternalCopies: 2 },
        };
      },
    });
    extTrash.init?.();

    const moved = await extTrash.moveToTrash(adminPrincipal, {
      kind: "order",
      publicId: ord.publicId,
      idempotencyKey: "idem-ext-move",
    });

    await expect(
      extTrash.purge(adminStepUpPrincipal, {
        items: [{ kind: "order", publicId: ord.publicId, batchId: moved.batchId }],
        confirmation: ord.reference,
        idempotencyKey: "idem-ext-purge-1",
      }),
    ).rejects.toMatchObject({ reasonCode: "EXTERNAL_COPIES_UNREACHABLE" });

    // Listed row surfaces failed run with unreachableExternalCopies = 2
    const listed = await extTrash.list(adminPrincipal, {
      kind: "order",
      sort: "movedAt",
      dir: "desc",
      limit: 20,
    });
    const row = listed.items.find((r) => r.publicId === ord.publicId);
    expect(row?.state).toBe("failed");
    expect(row?.failureCode).toBe("EXTERNAL_COPIES_UNREACHABLE");
    expect(row?.unreachableExternalCopies).toBe(2);
    const runId = row!.failedRunId!;

    // Retention cleanup never sets acknowledgedUnreachableCopies
    h.clock.advance(31 * 86_400_000);
    // Refresh session expiry & step-up after clock advance
    const freshNow = h.clock.now();
    await t.db
      .update(userSessions)
      .set({
        authenticatedAt: freshNow,
        lastSeenAt: freshNow,
        stepUpAt: freshNow,
        absoluteExpiresAt: new Date(freshNow.getTime() + 60 * 86_400_000),
      })
      .where(eq(userSessions.publicId, adminStepUpPrincipal.sessionId));
    adminStepUpPrincipal = { ...adminStepUpPrincipal, stepUpAt: freshNow };

    const retentionSweep = await extTrash.runRetentionCleanup("job-ext-never-ack");
    expect(retentionSweep.failed).toBe(1);
    expect(seenAckFlags).toEqual([false, false]);

    // Wrong typed confirmation is rejected
    await expect(
      extTrash.finishLeavingExternalCopies(adminStepUpPrincipal, {
        kind: "order",
        publicId: ord.publicId,
        batchId: moved.batchId,
        runId,
        confirmation: "WRONG-REF",
        idempotencyKey: "idem-ext-wrong-confirm",
      }),
    ).rejects.toMatchObject({ reasonCode: "CONFIRMATION_MISMATCH" });

    // Correct typed order reference records `order.purge_external_left` and completes with keptExternalCopies = 2
    const finished = await extTrash.finishLeavingExternalCopies(adminStepUpPrincipal, {
      kind: "order",
      publicId: ord.publicId,
      batchId: moved.batchId,
      runId,
      confirmation: ord.reference,
      idempotencyKey: "idem-ext-finish-ok",
    });
    expect(finished.keptExternalCopies).toBe(2);
    expect(seenAckFlags).toEqual([false, false, true]);
    const ackAudit = h.audit.named("order.purge_external_left");
    expect(ackAudit).toHaveLength(1);
    expect(ackAudit[0]?.attributes).toMatchObject({
      run_public_id: runId,
      kept_count: 2,
      connection_public_ids: connPubId,
      order_public_id: ord.publicId,
      trash_batch_id: moved.batchId,
    });
  });
});

describe("idempotency cross-batch protection, retention CAS, and router step-up", () => {
  it("rejects reusing an idempotency key after an order enters a new trash batch", async () => {
    const cust = await seedCustomer({ id: 50, status: "active" });
    const ord = await seedOrder({ id: 500, ownerUserId: cust.id, reference: "ORD-2026-0500" });

    const b1 = await trash.moveToTrash(adminPrincipal, {
      kind: "order",
      publicId: ord.publicId,
      idempotencyKey: "idem-batch-1",
    });
    await trash.restore(adminPrincipal, {
      items: [{ kind: "order", publicId: ord.publicId, batchId: b1.batchId }],
      idempotencyKey: "idem-restore-shared-key",
    });

    const b2 = await trash.moveToTrash(adminPrincipal, {
      kind: "order",
      publicId: ord.publicId,
      idempotencyKey: "idem-batch-2",
    });
    expect(b2.batchId).not.toBe(b1.batchId);

    // Replaying `idem-restore-shared-key` (even with the same item ref without batchId) must fail closed
    const r1 = await trash.moveToTrash(adminPrincipal, {
      kind: "order",
      publicId: ord.publicId,
      idempotencyKey: "idem-batch-2",
    });
    expect(r1.batchId).toBe(b2.batchId);

    await trash.restore(adminPrincipal, {
      items: [{ kind: "order", publicId: ord.publicId }],
      idempotencyKey: "idem-no-batch-restore",
    });
    await trash.moveToTrash(adminPrincipal, {
      kind: "order",
      publicId: ord.publicId,
      idempotencyKey: "idem-batch-3",
    });
    await expect(
      trash.restore(adminPrincipal, {
        items: [{ kind: "order", publicId: ord.publicId }],
        idempotencyKey: "idem-no-batch-restore",
      }),
    ).rejects.toMatchObject({ reasonCode: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("enforces exact preview counts, DELETE <N> confirmation, cohort STALE check, and tRPC step-up", async () => {
    const cust = await seedCustomer({ id: 60, status: "active" });
    const ord1 = await seedOrder({ id: 601, ownerUserId: cust.id, reference: "ORD-2026-0601" });
    const ord2 = await seedOrder({ id: 602, ownerUserId: cust.id, reference: "ORD-2026-0602" });

    await trash.moveToTrash(adminPrincipal, {
      kind: "order",
      publicId: ord1.publicId,
      idempotencyKey: "idem-ret-ord1",
    });

    // Advance 10 days: under 30-day default `ord1` is not due, under 7-day proposed `ord1` IS due!
    h.clock.advance(10 * 86_400_000);
    const now = h.clock.now();
    await t.db
      .update(userSessions)
      .set({
        authenticatedAt: now,
        lastSeenAt: now,
        stepUpAt: now,
        absoluteExpiresAt: new Date(now.getTime() + 60 * 86_400_000),
      })
      .where(eq(userSessions.publicId, adminStepUpPrincipal.sessionId));
    await t.db
      .update(userSessions)
      .set({
        authenticatedAt: now,
        lastSeenAt: now,
        absoluteExpiresAt: new Date(now.getTime() + 60 * 86_400_000),
      })
      .where(eq(userSessions.publicId, adminPrincipal.sessionId));
    adminStepUpPrincipal = { ...adminStepUpPrincipal, stepUpAt: now };

    const preview = await trash.previewSettings(adminPrincipal, {
      autoPurgeEnabled: true,
      orderDays: 7,
      customerDays: 30,
    });
    expect(preview.becomeDue).toBe(1);
    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.confirmationPhrase).toBe("DELETE 1");

    // Base session without step-up is rejected on `trash.settings.update` via tRPC router
    const baseCaller = makeCaller({
      request: newRequestContext("http"),
      transport: {} as never,
      session: adminPrincipal,
      services: h.services,
    });
    await expect(
      baseCaller.trash.settings.update({
        autoPurgeEnabled: true,
        orderDays: 7,
        customerDays: 30,
        expectedVersion: preview.version,
        reviewedDueCount: 1,
        confirmation: "DELETE 1",
        idempotencyKey: "idem-router-no-stepup",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Mutate due cohort (trash ord2 backdated or restore ord1) -> STALE when reviewedDueCount mismatches!
    await trash.moveToTrash(adminPrincipal, {
      kind: "order",
      publicId: ord2.publicId,
      idempotencyKey: "idem-ret-ord2",
    });
    await t.db
      .update(orders)
      .set({ trashedAt: new Date(now.getTime() - 9 * 86_400_000) })
      .where(eq(orders.id, ord2.id));

    const stepUpCaller = makeCaller({
      request: newRequestContext("http"),
      transport: {} as never,
      session: adminStepUpPrincipal,
      services: h.services,
    });

    await expect(
      stepUpCaller.trash.settings.update({
        autoPurgeEnabled: true,
        orderDays: 7,
        customerDays: 30,
        expectedVersion: preview.version,
        reviewedDueCount: 1,
        confirmation: "DELETE 1",
        idempotencyKey: "idem-stale-cohort",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Re-preview sees 2 due items and succeeds with `DELETE 2`
    const preview2 = await stepUpCaller.trash.settings.preview({
      autoPurgeEnabled: true,
      orderDays: 7,
      customerDays: 30,
    });
    expect(preview2.becomeDue).toBe(2);

    const updated = await stepUpCaller.trash.settings.update({
      autoPurgeEnabled: true,
      orderDays: 7,
      customerDays: 30,
      expectedVersion: preview2.version,
      reviewedDueCount: 2,
      confirmation: "DELETE 2",
      idempotencyKey: "idem-ret-update-ok",
    });
    expect(updated.orderDays).toBe(7);
    expect(updated.version).toBe(preview2.version + 1);
  });
});
