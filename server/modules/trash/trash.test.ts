/**
 * Scoped tests for `server/modules/trash` (Increment 09, Decision D2 & D2.8). Owner: recovery_ops_engineer.
 *
 * Uses synthetic fixtures only (`Zeus Greene`, `RPCUS-A1B2CJJG5`, project `Ice Queen`).
 */
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
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
import { storageCopyAttempts } from "../storage/schema.js";
import { createTrashModule, type TrashCoordinatorModule } from "./index.js";
import type { TrashEntityRef, TrashParticipant, TrashPurgeResult, TrashPurgeRun } from "./ports.js";
import { trashRouter } from "./router.js";
import {
  trashCleanupSweeps,
  trashIdempotencyKeys,
  trashPurgeRuns,
  trashPurgeRunTargets,
  trashRetentionDeferrals,
  trashRetentionState,
} from "./schema.js";
import type { Db } from "../../core/types.js";
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
  storageCopyAttempts,
  trashPurgeRuns,
  trashPurgeRunTargets,
  trashCleanupSweeps,
  trashRetentionDeferrals,
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

  h.services.jobAdmin = {
    isDraining: async () => false,
    maintenance: {
      customerAccess: async () => ({ active: false, message: null, updatedAt: null }),
    },
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

    // Manifest module registered WITHOUT a `purge` handler (and not in `manifestNoDataToPurge`) fails closed!
    const noPurgeTrash = createTrashModule(h.deps, {
      expectedParticipants: ["identity", "orders", "files", "noPurgeMod"],
    });
    for (const p of trash.participants()) noPurgeTrash.register(p);
    noPurgeTrash.register({ module: "noPurgeMod" });
    noPurgeTrash.init?.();

    await expect(
      noPurgeTrash.purge(adminStepUpPrincipal, {
        items: [{ kind: "order", publicId: ord.publicId, batchId: moved.batchId }],
        confirmation: ord.reference,
        idempotencyKey: "idem-no-purge-handler",
      }),
    ).rejects.toMatchObject({ reasonCode: "TRASH_PARTICIPANT_NO_PURGE_HANDLER" });

    // Explicitly documenting the module in `manifestNoDataToPurge` with a reason permits intentional no-op
    const documentedNoOpTrash = createTrashModule(h.deps, {
      expectedParticipants: ["identity", "orders", "files", "documentedNoOp"],
      manifestNoDataToPurge: {
        documentedNoOp: "Synthetic stateless module owns zero order or customer rows.",
      },
    });
    for (const p of trash.participants()) documentedNoOpTrash.register(p);
    documentedNoOpTrash.register({ module: "documentedNoOp" });
    documentedNoOpTrash.init?.();

    const okPurge = await documentedNoOpTrash.purge(adminStepUpPrincipal, {
      items: [{ kind: "order", publicId: ord.publicId, batchId: moved.batchId }],
      confirmation: ord.reference,
      idempotencyKey: "idem-documented-noop-ok",
    });
    expect(okPurge.results[0]?.ok).toBe(true);
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

    // Replaying `idem-batch-2` on `moveToTrash` returns the same batch idempotently
    const r1 = await trash.moveToTrash(adminPrincipal, {
      kind: "order",
      publicId: ord.publicId,
      idempotencyKey: "idem-batch-2",
    });
    expect(r1.batchId).toBe(b2.batchId);

    // Reusing `idem-restore-shared-key` (bound to `b1.batchId`) against `b2.batchId` fails closed (`IDEMPOTENCY_KEY_REUSED`)
    await expect(
      trash.restore(adminPrincipal, {
        items: [{ kind: "order", publicId: ord.publicId, batchId: b2.batchId }],
        idempotencyKey: "idem-restore-shared-key",
      }),
    ).rejects.toMatchObject({ reasonCode: "IDEMPOTENCY_KEY_REUSED" });

    // Router rejects omitted `batchId` on manual `restore` and `purge`
    const stepUpCaller = makeCaller({
      request: newRequestContext("http"),
      transport: {} as never,
      session: adminStepUpPrincipal,
      services: h.services,
    });
    await expect(
      stepUpCaller.trash.restore({
        items: [{ kind: "order", publicId: ord.publicId } as never],
        idempotencyKey: "idem-missing-batch-restore",
      }),
    ).rejects.toThrow();
    await expect(
      stepUpCaller.trash.purge({
        items: [{ kind: "order", publicId: ord.publicId } as never],
        confirmation: ord.reference,
        idempotencyKey: "idem-missing-batch-purge",
      }),
    ).rejects.toThrow();
  });

  it("atomically links reservation to claim, protects incomplete runs past 24h TTL, refuses cross-fingerprint reuse, and resumes on same-fingerprint retry", async () => {
    const cust = await seedCustomer({ id: 52, status: "active" });
    const ord = await seedOrder({ id: 502, ownerUserId: cust.id, reference: "ORD-2026-0502" });
    const ordOther = await seedOrder({ id: 503, ownerUserId: cust.id, reference: "ORD-2026-0503" });

    let shouldFail = true;
    const failingTrash = createTrashModule(h.deps, {
      expectedParticipants: ["identity", "orders", "failingMod"],
    });
    for (const p of trash.participants()) {
      if (p.module === "identity" || p.module === "orders") failingTrash.register(p);
    }
    failingTrash.register({
      module: "failingMod",
      purge: async (_entity, run) => {
        await t.db.transaction(async (tx) => {
          await run.assertCurrentInTx(tx);
        });
        if (shouldFail) {
          throw new DomainError("UNAVAILABLE", "DOWNSTREAM_TIMEOUT", "Downstream timed out.");
        }
        return { deleted: { rows: 1 } };
      },
    });
    failingTrash.init?.();

    const moved1 = await failingTrash.moveToTrash(adminPrincipal, {
      kind: "order",
      publicId: ord.publicId,
      idempotencyKey: "idem-fail-move-1",
    });
    const moved2 = await failingTrash.moveToTrash(adminPrincipal, {
      kind: "order",
      publicId: ordOther.publicId,
      idempotencyKey: "idem-fail-move-2",
    });

    await expect(
      failingTrash.purge(adminStepUpPrincipal, {
        items: [{ kind: "order", publicId: ord.publicId, batchId: moved1.batchId }],
        confirmation: ord.reference,
        idempotencyKey: "idem-retained-after-claim",
      }),
    ).rejects.toMatchObject({ reasonCode: "DOWNSTREAM_TIMEOUT" });

    // Verify durable atomic claim <-> reservation link in DB
    const idemRows = await t.db.select().from(trashIdempotencyKeys);
    const linkedIdem = idemRows.find((r) => r.claimedRunPublicId !== null);
    expect(linkedIdem).toBeDefined();
    expect(linkedIdem?.status).toBe("failed");

    // Advance clock > 24 h (25 hours) while run is STILL incomplete (`failed`): 24 h TTL clean-up MUST NOT drop it!
    h.clock.advance(25 * 3_600_000);
    const laterNow = h.clock.now();
    await t.db
      .update(userSessions)
      .set({
        authenticatedAt: laterNow,
        lastSeenAt: laterNow,
        stepUpAt: laterNow,
        absoluteExpiresAt: new Date(laterNow.getTime() + 60 * 86_400_000),
      })
      .where(eq(userSessions.publicId, adminStepUpPrincipal.sessionId));
    adminStepUpPrincipal = { ...adminStepUpPrincipal, stepUpAt: laterNow };

    // Reusing the same key for a different item/batch even after 25 hours STILL fails `IDEMPOTENCY_KEY_REUSED`!
    await expect(
      failingTrash.purge(adminStepUpPrincipal, {
        items: [{ kind: "order", publicId: ordOther.publicId, batchId: moved2.batchId }],
        confirmation: ordOther.reference,
        idempotencyKey: "idem-retained-after-claim",
      }),
    ).rejects.toMatchObject({ reasonCode: "IDEMPOTENCY_KEY_REUSED" });

    // Same-fingerprint retry on the same `idempotencyKey` resumes that exact run and completes once downstream recovers!
    shouldFail = false;
    const resumedSameKey = await failingTrash.purge(adminStepUpPrincipal, {
      items: [{ kind: "order", publicId: ord.publicId, batchId: moved1.batchId }],
      confirmation: ord.reference,
      idempotencyKey: "idem-retained-after-claim",
    });
    expect(resumedSameKey.results[0]?.ok).toBe(true);
    expect(resumedSameKey.runIds[0]).toBe(linkedIdem?.claimedRunPublicId);
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

    // Disabling auto clean-up is non-destructive (no confirmation required)
    const disabled = await stepUpCaller.trash.settings.update({
      autoPurgeEnabled: false,
      orderDays: 30,
      customerDays: 30,
      expectedVersion: updated.version,
      idempotencyKey: "idem-ret-disable",
    });
    expect(disabled.autoPurgeEnabled).toBe(false);

    // Shortening while disabled is non-destructive (no confirmation required)
    const previewDisabledShorten = await stepUpCaller.trash.settings.preview({
      autoPurgeEnabled: false,
      orderDays: 14,
      customerDays: 14,
    });
    expect(previewDisabledShorten.requiresConfirmation).toBe(false);
    expect(previewDisabledShorten.confirmationPhrase).toBeNull();

    // Enabling auto clean-up when 0 items become due STILL requires `DELETE 0` typed confirmation (D2.8)!
    const previewEnableZero = await stepUpCaller.trash.settings.preview({
      autoPurgeEnabled: true,
      orderDays: 365,
      customerDays: 365,
    });
    expect(previewEnableZero.becomeDue).toBe(0);
    expect(previewEnableZero.requiresConfirmation).toBe(true);
    expect(previewEnableZero.confirmationPhrase).toBe("DELETE 0");

    await expect(
      stepUpCaller.trash.settings.update({
        autoPurgeEnabled: true,
        orderDays: 365,
        customerDays: 365,
        expectedVersion: previewEnableZero.version,
        reviewedDueCount: 0,
        idempotencyKey: "idem-enable-zero-missing-phrase",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const enabledZero = await stepUpCaller.trash.settings.update({
      autoPurgeEnabled: true,
      orderDays: 365,
      customerDays: 365,
      expectedVersion: previewEnableZero.version,
      reviewedDueCount: 0,
      confirmation: "DELETE 0",
      idempotencyKey: "idem-enable-zero-ok",
    });
    expect(enabledZero.autoPurgeEnabled).toBe(true);
    expect(enabledZero.orderDays).toBe(365);
  });
});

describe("durable per-target ownership, pure row-lock participant fence, and retention single-flight progression", () => {
  it("enforces permanent per-target ownership across root/reassigned cascades and supports scoped per-order external-copy acknowledgment", async () => {
    const ownerA = await seedCustomer({ id: 70, status: "suspended", customerRef: "RPCUS-A1B2CJJG5" });
    const ownerB = await seedCustomer({ id: 71, status: "suspended", customerRef: "RPCUS-B2C3DKKH6" });
    const rootOrder = await seedOrder({
      id: 700,
      ownerUserId: ownerA.id,
      reference: "RP-2026-0700",
    });
    // Addition order in rootOrder's group, reassigned to ownerB!
    const reassignedChild = await seedOrder({
      id: 701,
      ownerUserId: ownerB.id,
      reference: "RP-2026-0701",
      groupRootOrderId: rootOrder.id,
    });
    const plainOrderA = await seedOrder({
      id: 702,
      ownerUserId: ownerA.id,
      reference: "RP-2026-0702",
    });

    const connPubId = ulid(h.clock.now().getTime() + 50);
    const srcPubIds = [
      ulid(h.clock.now().getTime() + 51),
      ulid(h.clock.now().getTime() + 52),
      ulid(h.clock.now().getTime() + 53),
    ];
    const copyPubIds = [
      ulid(h.clock.now().getTime() + 61),
      ulid(h.clock.now().getTime() + 62),
      ulid(h.clock.now().getTime() + 63),
    ];
    const seenByOrder = new Map<string, boolean[]>();
    const cascadeTrash = createTrashModule(h.deps, {
      expectedParticipants: ["identity", "orders", "files"],
    });
    for (const p of trash.participants()) {
      if (p.module === "identity" || p.module === "orders") cascadeTrash.register(p);
    }
    cascadeTrash.register({
      module: "files",
      purge: async (entity: TrashEntityRef, run: TrashPurgeRun): Promise<TrashPurgeResult> => {
        await t.db.transaction(async (tx) => {
          await run.assertCurrentInTx(tx);
        });
        if (entity.kind !== "order") return { deleted: {} };
        const arr = seenByOrder.get(entity.publicId) ?? [];
        arr.push(Boolean(run.acknowledgedUnreachableCopies));
        seenByOrder.set(entity.publicId, arr);
        // Only `reassignedChild` has unreachable external copies; stamp the per-run `storage_copy_attempts` journal (`8d4b57c`)!
        if (entity.publicId === reassignedChild.publicId && !run.acknowledgedUnreachableCopies) {
          const jNow = h.clock.now();
          for (let i = 0; i < 3; i += 1) {
            await t.db.insert(storageCopyAttempts).values({
              publicId: ulid(jNow.getTime() + 70 + i),
              kind: "order_file",
              sourcePublicId: srcPubIds[i]!,
              orderPublicId: reassignedChild.publicId,
              connectionPublicId: connPubId,
              jobPublicId: `trash-un:${run.runId}:${copyPubIds[i]!}`,
              attempt: 1,
              state: "not_written",
              errorCode: "EXTERNAL_COPIES_UNREACHABLE",
              createdAt: jNow,
              finishedAt: jNow,
            });
          }
          throw new DomainError(
            "UNAVAILABLE",
            "EXTERNAL_COPIES_UNREACHABLE",
            "External destination rotated.",
            { unreachableCopies: 3, unreachableCopyCounts: [`${connPubId}:3`] },
          );
        }
        return {
          deleted: { files: 1 },
          ...(run.acknowledgedUnreachableCopies ? { kept: { acknowledgedExternalCopies: 3 } } : {}),
        };
      },
    });
    cascadeTrash.init?.();

    const childTrashMove = await cascadeTrash.moveToTrash(adminPrincipal, {
      kind: "order",
      publicId: reassignedChild.publicId,
      idempotencyKey: "idem-reassigned-child-trash",
    });
    const custBTrashMove = await cascadeTrash.moveToTrash(adminPrincipal, {
      kind: "customer",
      publicId: ownerB.publicId,
      idempotencyKey: "idem-cust-b-trash",
    });
    const custATrashMove = await cascadeTrash.moveToTrash(adminPrincipal, {
      kind: "customer",
      publicId: ownerA.publicId,
      idempotencyKey: "idem-cust-a-trash",
    });

    // Purging customer A claims `[rootOrder, reassignedChild, plainOrderA, ownerA]` in `trash_purge_run_targets` and halts on `reassignedChild`!
    await expect(
      cascadeTrash.purge(adminStepUpPrincipal, {
        items: [{ kind: "customer", publicId: ownerA.publicId, batchId: custATrashMove.batchId }],
        confirmation: ownerA.customerRef,
        idempotencyKey: "idem-purge-cust-a-1",
      }),
    ).rejects.toMatchObject({ reasonCode: "EXTERNAL_COPIES_UNREACHABLE" });

    // Even while failed, `ownerA`'s run exclusively owns `reassignedChild` AND `rootOrder`!
    // Attempting a standalone purge of `reassignedChild` OR `ownerB` fails with `PURGE_ALREADY_OWNED` (never creates a second run)!
    await expect(
      cascadeTrash.purge(adminStepUpPrincipal, {
        items: [{ kind: "order", publicId: reassignedChild.publicId, batchId: childTrashMove.batchId }],
        confirmation: reassignedChild.reference,
        idempotencyKey: "idem-competing-child-purge",
      }),
    ).rejects.toMatchObject({ reasonCode: "PURGE_ALREADY_OWNED" });

    await expect(
      cascadeTrash.purge(adminStepUpPrincipal, {
        items: [{ kind: "customer", publicId: ownerB.publicId, batchId: custBTrashMove.batchId }],
        confirmation: ownerB.customerRef,
        idempotencyKey: "idem-competing-cust-b-purge",
      }),
    ).rejects.toMatchObject({ reasonCode: "PURGE_ALREADY_OWNED" });

    const allRuns = await t.db.select().from(trashPurgeRuns);
    expect(allRuns).toHaveLength(1);
    const owningRunId = allRuns[0]!.publicId;

    // `trash.list` on customers surfaces `failedRunId`, `failedTargetPublicId` (`reassignedChild`), and `failedTargetReference` (`RP-2026-0701`)!
    const custList = await cascadeTrash.list(adminPrincipal, {
      kind: "customer",
      sort: "movedAt",
      dir: "desc",
      limit: 20,
    });
    const custARow = custList.items.find((r) => r.publicId === ownerA.publicId);
    expect(custARow).toMatchObject({
      state: "failed",
      failureCode: "EXTERNAL_COPIES_UNREACHABLE",
      unreachableExternalCopies: 3,
      failedRunId: owningRunId,
      failedTargetPublicId: reassignedChild.publicId,
      failedTargetReference: reassignedChild.reference,
    });

    // Blanket confirmation with customer ID or root order reference is REJECTED — must type `reassignedChild.reference`!
    await expect(
      cascadeTrash.finishLeavingExternalCopies(adminStepUpPrincipal, {
        kind: "customer",
        publicId: ownerA.publicId,
        batchId: custATrashMove.batchId,
        runId: owningRunId,
        confirmation: ownerA.customerRef,
        idempotencyKey: "idem-blanket-cust-confirm-rejected",
      }),
    ).rejects.toMatchObject({ reasonCode: "CONFIRMATION_MISMATCH" });

    await expect(
      cascadeTrash.finishLeavingExternalCopies(adminStepUpPrincipal, {
        kind: "customer",
        publicId: ownerA.publicId,
        batchId: custATrashMove.batchId,
        runId: owningRunId,
        confirmation: rootOrder.reference,
        idempotencyKey: "idem-wrong-order-confirm-rejected",
      }),
    ).rejects.toMatchObject({ reasonCode: "CONFIRMATION_MISMATCH" });

    // Attempting to acknowledge an incomplete SIBLING order (`plainOrderA`) that has NOT failed is REFUSED (`EXTERNAL_COPIES_ACK_NOT_APPLICABLE`)!
    await expect(
      cascadeTrash.finishLeavingExternalCopies(adminStepUpPrincipal, {
        kind: "customer",
        publicId: ownerA.publicId,
        batchId: custATrashMove.batchId,
        runId: owningRunId,
        targetOrderPublicId: plainOrderA.publicId,
        confirmation: plainOrderA.reference,
        idempotencyKey: "idem-sibling-order-ack-refused",
      }),
    ).rejects.toMatchObject({ reasonCode: "EXTERNAL_COPIES_ACK_NOT_APPLICABLE" });

    // Typing `RP-2026-0701` (`reassignedChild.reference`) scopes acknowledgment ONLY to `reassignedChild` and binds to its exact journal proof stamps!
    const finished = await cascadeTrash.finishLeavingExternalCopies(adminStepUpPrincipal, {
      kind: "customer",
      publicId: ownerA.publicId,
      batchId: custATrashMove.batchId,
      runId: owningRunId,
      targetOrderPublicId: reassignedChild.publicId,
      confirmation: reassignedChild.reference,
      idempotencyKey: "idem-scoped-child-ack-ok",
    });
    expect(finished).toMatchObject({ ok: true, runId: owningRunId, keptExternalCopies: 3 });

    const [childTargetAfter] = await t.db
      .select()
      .from(trashPurgeRunTargets)
      .where(eq(trashPurgeRunTargets.entityPublicId, reassignedChild.publicId));
    const savedProof = JSON.parse(childTargetAfter!.leaveExternalCopiesProofJson ?? "{}") as {
      runId: string;
      orderPublicId: string;
      stamps: string[];
      unreachableTotal: number;
    };
    expect(savedProof.runId).toBe(owningRunId);
    expect(savedProof.orderPublicId).toBe(reassignedChild.publicId);
    expect(savedProof.stamps).toHaveLength(3);
    expect(savedProof.unreachableTotal).toBe(3);

    const extLeftAudits = h.audit.named("order.purge_external_left");
    expect(extLeftAudits).toHaveLength(1);
    expect(extLeftAudits[0]?.attributes).toMatchObject({
      order_public_id: reassignedChild.publicId,
      kept_count: 3,
      connection_public_ids: connPubId,
    });

    // `plainOrderA` (executed AFTER `reassignedChild` in `id ASC`) NEVER received `acknowledgedUnreachableCopies: true`!
    expect(seenByOrder.get(reassignedChild.publicId)).toEqual([false, true]);
    expect(seenByOrder.get(plainOrderA.publicId)).toEqual([false]);
  });

  it("fences takeover on FOR SHARE / FOR UPDATE row locks during a destructive step and renews lease via heartbeat", async () => {
    const cust = await seedCustomer({ id: 80, status: "active" });
    const ord = await seedOrder({ id: 800, ownerUserId: cust.id, reference: "RP-2026-0800" });

    let notifyW1HoldingShare!: () => void;
    const w1HoldingSharePromise = new Promise<void>((resolve) => {
      notifyW1HoldingShare = resolve;
    });
    let releaseW1FirstTx!: () => void;
    const w1FirstTxGate = new Promise<void>((resolve) => {
      releaseW1FirstTx = resolve;
    });
    let releaseW1BeforeSecondTx!: () => void;
    const w1SecondTxGate = new Promise<void>((resolve) => {
      releaseW1BeforeSecondTx = resolve;
    });

    let secondDestructiveWriteCommitted = false;
    let participantAttempt = 0;

    const raceTrash = createTrashModule(h.deps, {
      expectedParticipants: ["identity", "orders", "destructiveMod"],
      runLeaseMs: 1_000,
      runHeartbeatMs: 60_000,
    });
    for (const part of trash.participants()) {
      if (part.module === "identity" || part.module === "orders") raceTrash.register(part);
    }
    raceTrash.register({
      module: "destructiveMod",
      purge: async (_entity, run) => {
        const myAttempt = ++participantAttempt;
        if (myAttempt === 1) {
          // Worker 1 opens an in-flight destructive DB transaction holding `FOR SHARE` on `trash_purge_runs`!
          await t.db.transaction(async (tx) => {
            await run.assertCurrentInTx(tx);
            notifyW1HoldingShare();
            await w1FirstTxGate;
          });
          // Wait until Worker 2 finishes taking over, then attempt a second local DB mutation — MUST fail `PURGE_FENCE_LOST`!
          await w1SecondTxGate;
          await t.db.transaction(async (tx) => {
            await run.assertCurrentInTx(tx);
            secondDestructiveWriteCommitted = true;
          });
          return { deleted: { rows: 1 } };
        }
        // Worker 2 (takeover worker): executes cleanly under `fencingToken = 2`!
        await t.db.transaction(async (tx) => {
          await run.assertCurrentInTx(tx);
        });
        return { deleted: { rows: 1 } };
      },
    });
    raceTrash.init?.();

    const moved = await raceTrash.moveToTrash(adminPrincipal, {
      kind: "order",
      publicId: ord.publicId,
      idempotencyKey: "idem-race-move",
    });

    const worker1Promise = raceTrash.purge(adminStepUpPrincipal, {
      items: [{ kind: "order", publicId: ord.publicId, batchId: moved.batchId }],
      confirmation: ord.reference,
      idempotencyKey: "idem-race-worker-1",
    });

    await w1HoldingSharePromise;

    // Advance fake clock past `runLeaseMs` while Worker 1 STILL holds `FOR SHARE` in MySQL!
    h.clock.advance(5_000);
    const later = h.clock.now();
    await t.db
      .update(userSessions)
      .set({
        authenticatedAt: later,
        lastSeenAt: later,
        stepUpAt: later,
        absoluteExpiresAt: new Date(later.getTime() + 60 * 86_400_000),
      })
      .where(eq(userSessions.publicId, adminStepUpPrincipal.sessionId));
    adminStepUpPrincipal = { ...adminStepUpPrincipal, stepUpAt: later };

    // Start Worker 2 takeover NOW while Worker 1's `FOR SHARE` tx is STILL open on another connection!
    let worker2Settled = false;
    const worker2Promise = raceTrash
      .purge(adminStepUpPrincipal, {
        items: [{ kind: "order", publicId: ord.publicId, batchId: moved.batchId }],
        confirmation: ord.reference,
        idempotencyKey: "idem-race-worker-2",
      })
      .then((res) => {
        worker2Settled = true;
        return res;
      });

    // Give MySQL 60ms: Worker 2 MUST still be waiting on InnoDB `FOR UPDATE` because Worker 1 holds `FOR SHARE`!
    await new Promise((r) => setTimeout(r, 60));
    expect(worker2Settled).toBe(false);
    expect(participantAttempt).toBe(1);

    // Release Worker 1's first transaction -> Worker 2 acquires `FOR UPDATE`, increments `fencingToken` to 2, and finishes!
    releaseW1FirstTx();
    const w2Done = await worker2Promise;
    expect(w2Done.results[0]?.ok).toBe(true);

    const [runAfterTakeover] = await t.db.select().from(trashPurgeRuns);
    expect(runAfterTakeover?.fencingToken).toBe(2);
    expect(runAfterTakeover?.status).toBe("completed");

    // Unblock Worker 1's second transaction: `run.assertCurrentInTx(tx)` sees superseded token/status and fails `PURGE_FENCE_LOST`!
    releaseW1BeforeSecondTx();
    await expect(worker1Promise).rejects.toMatchObject({ reasonCode: "PURGE_FENCE_LOST" });
    expect(secondDestructiveWriteCommitted).toBe(false);

    // Also verify background heartbeat timer extends `leaseExpiresAt` during a long step so an active worker is NOT stolen!
    const ordHb = await seedOrder({ id: 801, ownerUserId: cust.id, reference: "RP-2026-0801" });
    const hbTrash = createTrashModule(h.deps, {
      expectedParticipants: ["identity", "orders", "longStepMod"],
      runLeaseMs: 1_000,
      runHeartbeatMs: 25,
    });
    for (const part of trash.participants()) {
      if (part.module === "identity" || part.module === "orders") hbTrash.register(part);
    }
    hbTrash.register({
      module: "longStepMod",
      purge: async (_entity, run) => {
        h.clock.advance(400);
        await new Promise((r) => setTimeout(r, 70));
        await t.db.transaction(async (tx) => {
          await run.assertCurrentInTx(tx);
        });
        return { deleted: { rows: 1 } };
      },
    });
    hbTrash.init?.();

    const movedHb = await hbTrash.moveToTrash(adminPrincipal, {
      kind: "order",
      publicId: ordHb.publicId,
      idempotencyKey: "idem-hb-move",
    });
    const hbDone = await hbTrash.purge(adminStepUpPrincipal, {
      items: [{ kind: "order", publicId: ordHb.publicId, batchId: movedHb.batchId }],
      confirmation: ordHb.reference,
      idempotencyKey: "idem-hb-purge",
    });
    expect(hbDone.results[0]?.ok).toBe(true);
  });

  it("operates end-to-end with RP_DB_POOL_SIZE = 1 without self-deadlock", async () => {
    const cust = await seedCustomer({ id: 85, status: "active" });
    const ord1 = await seedOrder({ id: 850, ownerUserId: cust.id, reference: "RP-2026-0850" });
    const ord2 = await seedOrder({ id: 851, ownerUserId: cust.id, reference: "RP-2026-0851" });

    const singlePool = mysql.createPool({
      uri: t.url,
      connectionLimit: 1,
      timezone: "Z",
      supportBigNumbers: true,
      charset: "utf8mb4",
    });
    try {
      const singleDb = drizzle(singlePool, { mode: "default" }) as unknown as Db;
      const h1 = createTestDeps({ db: singleDb, now: h.clock.now() });
      h1.services.assurance = h.services.assurance;
      h1.services.jobAdmin = h.services.jobAdmin;
      h1.services.opsAlerts = h.services.opsAlerts;
      h1.services.identity = createIdentityModule(h1.deps);
      const ordTrash1 = createOrderTrash({
        db: singleDb,
        clock: h1.clock,
        services: h1.services,
        workflows: { byVersionId: async () => ({ definition: { states: [] } }) as never },
      });
      h1.services.orders = { trash: ordTrash1 } as never;

      const trash1 = createTrashModule(h1.deps, {
        expectedParticipants: ["identity", "orders", "files"],
      });
      h1.services.trash = trash1;
      h1.services.identity.init?.();
      trash1.register(ordTrash1.participant);
      trash1.register({
        module: "files",
        purge: async (_entity, run) => {
          return singleDb.transaction(async (tx) => {
            await run.assertCurrentInTx(tx);
            return { deleted: { files: 1 } };
          });
        },
      });
      trash1.init?.();

      const m1 = await trash1.moveToTrash(adminPrincipal, {
        kind: "order",
        publicId: ord1.publicId,
        idempotencyKey: "idem-pool1-move-1",
      });
      const p1 = await trash1.purge(adminStepUpPrincipal, {
        items: [{ kind: "order", publicId: ord1.publicId, batchId: m1.batchId }],
        confirmation: ord1.reference,
        idempotencyKey: "idem-pool1-purge-1",
      });
      expect(p1.results[0]?.ok).toBe(true);

      await trash1.moveToTrash(adminPrincipal, {
        kind: "order",
        publicId: ord2.publicId,
        idempotencyKey: "idem-pool1-move-2",
      });
      h1.clock.advance(31 * 86_400_000);
      const sweepRes = await trash1.runRetentionCleanup("job-pool1-sweep");
      expect(sweepRes.purged).toBe(1);
    } finally {
      await singlePool.end();
    }
  });

  it("enforces row-fenced single-active sweep, persistent backoff (cap 24h) & single-shot alerts across held/failing items, job lease recheck, and drain gate", async () => {
    const cust = await seedCustomer({ id: 90, status: "active" });
    const failingHead = await seedOrder({ id: 901, ownerUserId: cust.id, reference: "RP-2026-0901" });
    const heldItems = [];
    for (let i = 0; i < 8; i++) {
      heldItems.push(
        await seedOrder({
          id: 910 + i,
          ownerUserId: cust.id,
          reference: `RP-2026-09${10 + i}`,
        }),
      );
    }
    const healthyTail = await seedOrder({ id: 999, ownerUserId: cust.id, reference: "RP-2026-0999" });

    const sweepTrash = createTrashModule(h.deps, {
      expectedParticipants: ["identity", "orders", "selectiveFail"],
      sweepLeaseMs: 60_000,
    });
    for (const part of trash.participants()) {
      if (part.module === "identity" || part.module === "orders") sweepTrash.register(part);
    }
    let failHeadCalls = 0;
    sweepTrash.register({
      module: "selectiveFail",
      purge: async (entity: TrashEntityRef, run: TrashPurgeRun) => {
        await t.db.transaction(async (tx) => {
          await run.assertCurrentInTx(tx);
        });
        if (entity.publicId === failingHead.publicId) {
          failHeadCalls += 1;
          throw new DomainError("UNAVAILABLE", "HEAD_ITEM_BROKEN", "Head item storage error.");
        }
        return { deleted: { rows: 1 } };
      },
    });
    sweepTrash.init?.();

    await sweepTrash.moveToTrash(adminPrincipal, {
      kind: "order",
      publicId: failingHead.publicId,
      idempotencyKey: "idem-sweep-head",
    });
    for (const hi of heldItems) {
      h.clock.advance(500);
      await sweepTrash.moveToTrash(adminPrincipal, {
        kind: "order",
        publicId: hi.publicId,
        idempotencyKey: `idem-sweep-held-${hi.id}`,
      });
      await t.db.update(orders).set({ lockState: "legal_hold" }).where(eq(orders.id, hi.id));
    }
    h.clock.advance(500);
    await sweepTrash.moveToTrash(adminPrincipal, {
      kind: "order",
      publicId: healthyTail.publicId,
      idempotencyKey: "idem-sweep-tail",
    });

    h.clock.advance(31 * 86_400_000);

    // 1. Row-based single-active sweep check: an unexpired `active_slot = 1` row skips with `SWEEP_ALREADY_RUNNING`
    const sweepNow = h.clock.now();
    await t.db.insert(trashCleanupSweeps).values({
      publicId: ulid(sweepNow.getTime()),
      status: "running",
      activeSlot: 1,
      fencingToken: 1,
      leaseOwner: "other-worker",
      leaseExpiresAt: new Date(sweepNow.getTime() + 60_000),
      purgedCount: 0,
      failedCount: 0,
      startedAt: sweepNow,
    });
    const skippedActive = await sweepTrash.runRetentionCleanup("job-single-flight");
    expect(skippedActive.skippedReason).toBe("SWEEP_ALREADY_RUNNING");

    // Advance past the stale sweep's `leaseExpiresAt`: next sweep reclaims `active_slot = 1`!
    h.clock.advance(61_000);

    // 2. Fail-closed if `jobAdmin` drain gate is missing, and skips when `isDraining(tx)` returns true
    const savedJobAdmin = h.services.jobAdmin;
    delete (h.services as { jobAdmin?: unknown }).jobAdmin;
    await expect(sweepTrash.runRetentionCleanup("job-missing-drain-gate")).rejects.toMatchObject({
      reasonCode: "MAINTENANCE_GATE_UNAVAILABLE",
    });

    let sawTxInIsDraining = false;
    h.services.jobAdmin = {
      isDraining: async (passedTx?: unknown) => {
        if (passedTx) sawTxInIsDraining = true;
        return true;
      },
      maintenance: { customerAccess: async () => ({ active: false, message: null, updatedAt: null }) },
    } as never;
    const drainSkip = await sweepTrash.runRetentionCleanup("job-draining");
    expect(drainSkip.skippedReason).toBe("WORKER_DRAINING");
    expect(sawTxInIsDraining).toBe(true);
    h.services.jobAdmin = savedJobAdmin;

    // 3. Sweep 1 progresses past `failingHead` AND all 8 `heldItems` to purge `healthyTail`, rechecking `jobFence` before EVERY target!
    opsEmitted = [];
    let leaseChecks = 0;
    const abortCtrl = new AbortController();
    const sweep1 = await sweepTrash.runRetentionCleanup("job-fair-sweep-1", {
      signal: abortCtrl.signal,
      assertStillOwned: async () => {
        leaseChecks += 1;
      },
    });
    expect(leaseChecks).toBeGreaterThanOrEqual(10);
    expect(sweep1.failed).toBe(1);
    expect(sweep1.purged).toBe(1);
    expect(failHeadCalls).toBe(1);

    const legalHoldAlertsAfterSweep1 = opsEmitted.filter((a) => a.code === "ORDER_ON_LEGAL_HOLD");
    expect(legalHoldAlertsAfterSweep1).toHaveLength(heldItems.length);

    const [tailAfter] = await t.db.select().from(orders).where(eq(orders.id, healthyTail.id));
    expect(tailAfter?.purgedAt).not.toBeNull();

    // 4. Immediate Sweep 2 skips ALL held items AND `failingHead` in SQL (`due === 0`, `0` new alerts, `failHeadCalls` stays 1)!
    const sweep2 = await sweepTrash.runRetentionCleanup("job-fair-sweep-2");
    expect(sweep2.due).toBe(0);
    expect(failHeadCalls).toBe(1);

    // 5. Even after advancing 2 hours (when 1-hour initial deferral elapses), held items re-defer with doubled backoff (2h -> 4h ... -> 24h cap) and DO NOT emit duplicate alerts (`alertedAt` already set)!
    h.clock.advance(2 * 3_600_000);
    await sweepTrash.runRetentionCleanup("job-fair-sweep-3");
    const legalHoldAlertsAfterSweep3 = opsEmitted.filter((a) => a.code === "ORDER_ON_LEGAL_HOLD");
    expect(legalHoldAlertsAfterSweep3).toHaveLength(heldItems.length);
  });
});
