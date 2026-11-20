import { and, eq } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { conflict, notFound } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { ClaimedJob, SessionPrincipal, Tx } from "../../core/types.js";
import type { OperationState } from "../../../shared/domain.js";
import { portableImports, portableImportSteps, type ImportPhase } from "./schema.js";

export type ImportRow = typeof portableImports.$inferSelect;
export type ImportJob = ClaimedJob<{ importId: string }>;
export const KNOWN_FAILURE_PHASES = ["failed", "held-unknown", "canceled"] as const;

const NEXT: Partial<Record<ImportPhase, ImportPhase>> = {
  received: "quarantined", quarantined: "verified", verified: "planned", planned: "approved",
  approved: "objects-prepared", "objects-prepared": "records-committed",
  "records-committed": "finalized", finalized: "reconciled", reconciled: "accepted",
};
const RESULT: Record<ImportPhase, OperationState> = {
  received: "running", quarantined: "queued", verified: "running", planned: "queued", approved: "queued",
  "objects-prepared": "running", "records-committed": "running", finalized: "running",
  reconciled: "completed", accepted: "completed", "held-unknown": "unknown", failed: "failed", canceled: "canceled",
};

export async function readImport(deps: ModuleDeps, importId: string) {
  const [row] = await deps.db.select().from(portableImports).where(eq(portableImports.publicId, importId)).limit(1);
  if (!row) throw notFound("PORTABLE_IMPORT_NOT_FOUND");
  return row;
}

export async function lockImport(tx: Tx, importId: string) {
  const [row] = await tx.select().from(portableImports).where(eq(portableImports.publicId, importId)).limit(1).for("update");
  if (!row) throw notFound("PORTABLE_IMPORT_NOT_FOUND");
  return row;
}

type ReceiptContext = {
  principal?: SessionPrincipal;
  job?: ImportJob;
  reasonCode?: string;
  state?: OperationState;
};

async function receipt(deps: ModuleDeps, tx: Tx, row: ImportRow, from: ImportPhase | null, ctx: ReceiptContext) {
  const operationId = ulid(deps.clock.now().getTime());
  await tx.insert(portableImportSteps).values({
    publicId: operationId, importId: row.id, toPhase: row.phase, fromPhase: from,
    inputSha256: row.inputSha256, planDigest: row.planDigest, installationId: row.installationId,
    actorUserId: ctx.principal?.userId ?? row.approvedBy, stepUpAt: ctx.principal?.stepUpAt ?? row.approvalStepUpAt,
    jobId: ctx.job?.jobId, fence: ctx.job?.fencingToken, createdAt: deps.clock.now(),
  });
  await deps.audit.record({
    category: "portable_transfer", eventName: "portable.import.transition", action: "transition",
    outcome: row.state === "unknown" || row.state === "failed" || row.state === "refused" || row.state === "canceled"
      ? row.state : row.phase === "received" ? "attempted" : "completed",
    reasonCode: ctx.reasonCode, correlationId: row.publicId, importId: row.publicId,
    packageId: row.packageId ?? undefined, jobId: ctx.job?.jobId,
    actor: ctx.principal ? { role: "admin", userId: ctx.principal.userId } : { role: "system" },
    resource: { type: "portable_import", publicId: row.publicId },
    attributes: { operation_id: operationId, phase: row.phase },
  }, tx);
}

export async function recordReceived(deps: ModuleDeps, tx: Tx, row: ImportRow, principal: SessionPrincipal) {
  await receipt(deps, tx, row, null, { principal });
}

export async function transition(
  deps: ModuleDeps, tx: Tx, row: ImportRow, to: ImportPhase, ctx: ReceiptContext,
  fields: Partial<Omit<ImportRow, "id" | "publicId" | "phase" | "state" | "version">> = {},
) {
  if (row.phase === to) return row;
  const isTerminal = row.phase === "accepted" || KNOWN_FAILURE_PHASES.some((phase) => phase === row.phase);
  if (isTerminal || (NEXT[row.phase] !== to && !KNOWN_FAILURE_PHASES.some((phase) => phase === to))) {
    throw conflict("PORTABLE_PHASE_MISMATCH", "This operation is no longer allowed in the current import phase.");
  }
  if (ctx.job) await ctx.job.assertStillOwned(tx);
  const changes = {
    ...fields, phase: to, state: ctx.state ?? RESULT[to], updatedAt: deps.clock.now(),
    version: row.version + 1, reasonCode: ctx.reasonCode ?? null,
  };
  const next = { ...row, ...changes };
  await receipt(deps, tx, next, row.phase, ctx);
  await tx.update(portableImports).set(changes).where(and(eq(portableImports.id, row.id), eq(portableImports.version, row.version)));
  return next;
}

export function importView(row: ImportRow) {
  return {
    importId: row.publicId, phase: row.phase, state: row.state, reasonCode: row.reasonCode,
    createdAt: row.createdAt, updatedAt: row.updatedAt, packageId: row.packageId, bytes: row.inputSize,
    inputSha256: row.inputSha256, planDigest: row.planDigest, planExpiresAt: row.planExpiresAt,
    plan: row.plan, reconciliation: row.reconciliation,
  };
}
