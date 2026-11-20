/**
 * Audit module (audit center) — public service surface and factory. Owner: audit engineer.
 * Reached as `deps.services.auditCenter` (the emitter is `deps.audit`). See API.md.
 */
import type { ModuleDeps } from "../../container.js";
import type { ModuleHealth, ModuleLifecycle, SessionPrincipal } from "../../core/types.js";
import type { AuditCtx } from "./access.js";
import * as cases from "./cases.js";
import { createChainService, HORIZON_MS, type ChainVerification } from "./chain.js";
import { isDurableAuditEmitter } from "./emitter.js";
import { projectForExternal, type AuditEnvelope, type ExternalAuditEvent } from "./envelope.js";
import * as exportsSvc from "./exports.js";
import * as integrity from "./integrity.js";
import * as retention from "./retention.js";
import * as searchSvc from "./search.js";

export type { AuditEnvelope, ExternalAuditEvent } from "./envelope.js";
export type { ChainVerification } from "./chain.js";
export type { AuditQuery, Group as AuditQueryGroup, Term as AuditQueryTerm, PivotKind, StatBucket, StatDimension } from "./query.js";

export const SEAL_JOB = "audit.chain.seal";
export const SWEEP_JOB = "audit.chain.sweep";
export const CHECKPOINT_JOB = "audit.checkpoint.create";

type P = SessionPrincipal;
type Tail<F> = F extends (ctx: AuditCtx, principal: P, ...rest: infer R) => infer O ? (principal: P, ...rest: R) => O : never;

export interface AuditModule extends ModuleLifecycle {
  /* ---- for other modules (SIEM, backup, portable) — no principal: trusted server-side callers only ---- */
  readEventsAfter(cursor: string | null, limit: number): Promise<{ events: AuditEnvelope[]; nextCursor: string | null; headSeq: number; pruned: number; missing: number }>;
  projectForExternal(event: AuditEnvelope): ExternalAuditEvent;
  sealPending(options?: { fullScan?: boolean }): Promise<{ sealed: number; headSeq: number }>;
  verifyChain(options?: { fromSeq?: number; maxEvents?: number }): Promise<ChainVerification>;

  /* ---- audit center (principal-scoped, capability re-checked, self-audited) ---- */
  search: Tail<typeof searchSvc.search>;
  getEvent: Tail<typeof searchSvc.getEvent>;
  revealSourceAddress: Tail<typeof searchSvc.revealSourceAddress>;
  pivot: Tail<typeof searchSvc.pivot>;
  stats: Tail<typeof searchSvc.stats>;
  listSavedQueries: Tail<typeof cases.listSavedQueries>;
  saveQuery: Tail<typeof cases.saveQuery>;
  deleteSavedQuery: Tail<typeof cases.deleteSavedQuery>;
  listCases: Tail<typeof cases.listCases>;
  getCase: Tail<typeof cases.getCase>;
  createCase: Tail<typeof cases.createCase>;
  updateCaseStatus: Tail<typeof cases.updateCaseStatus>;
  attachEvents: Tail<typeof cases.attachEvents>;
  addCaseNote: Tail<typeof cases.addCaseNote>;
  requestExport: Tail<typeof exportsSvc.requestExport>;
  listExports: Tail<typeof exportsSvc.listExports>;
  openExportDownload: Tail<typeof exportsSvc.openExportDownload>;
  recordDownloadResult: Tail<typeof exportsSvc.recordDownloadResult>;
  integrityStatus: Tail<typeof integrity.integrityStatus>;
  verifyIntegrity: Tail<typeof integrity.verifyIntegrity>;
  listCheckpoints: Tail<typeof integrity.listCheckpoints>;
  createCheckpoint: Tail<typeof integrity.createCheckpointAsAdmin>;
  getRetention: Tail<typeof retention.getRetention>;
  setRetentionPolicy: Tail<typeof retention.setRetentionPolicy>;
  createLegalHold: Tail<typeof retention.createLegalHold>;
  releaseLegalHold: Tail<typeof retention.releaseLegalHold>;
  runRetention: Tail<typeof retention.runRetentionAsAdmin>;
}

const bind =
  <R extends unknown[], O>(ctx: AuditCtx, fn: (ctx: AuditCtx, principal: P, ...rest: R) => O) =>
  (principal: P, ...rest: R): O =>
    fn(ctx, principal, ...rest);

export function createAuditModule(deps: ModuleDeps): AuditModule {
  const chain = createChainService({ db: deps.db, clock: deps.clock, logger: deps.logger, auditChainKey: deps.config.auditChainKey, installationId: deps.config.installationId });
  const ctx: AuditCtx = { deps, chain };

  deps.jobs.register(SEAL_JOB, async () => {
    const result = await chain.sealPending();
    return { outcome: "completed", safeCounts: { sealed: result.sealed } };
  });
  deps.jobs.register(SWEEP_JOB, async () => {
    const result = await chain.sealPending({ fullScan: true });
    return { outcome: "completed", safeCounts: { sealed: result.sealed } };
  });
  deps.jobs.register(CHECKPOINT_JOB, async () => {
    await chain.sealPending();
    const cp = await chain.createCheckpoint("scheduled");
    return { outcome: "completed", safeCounts: { seq: cp.seq } };
  });
  deps.jobs.register<{ exportId?: unknown }>(exportsSvc.EXPORT_JOB, (job) => exportsSvc.generateExport(ctx, job));
  deps.jobs.register(retention.RETENTION_JOB, async () => {
    const run = await retention.runRetention(ctx, { dryRun: false, requestedBy: null });
    return run.status === "completed" ? { outcome: "completed", safeCounts: run.counts } : { outcome: "failed", reasonCode: "RETENTION_FAILED", retryable: true };
  });
  deps.jobs.registerSchedule({ name: "audit.chain.seal", type: SEAL_JOB, everyMs: 10_000 });
  deps.jobs.registerSchedule({ name: "audit.chain.sweep", type: SWEEP_JOB, everyMs: 24 * 3_600_000 });
  deps.jobs.registerSchedule({ name: "audit.checkpoint.hourly", type: CHECKPOINT_JOB, everyMs: 3_600_000 });
  deps.jobs.registerSchedule({ name: "audit.retention.daily", type: retention.RETENTION_JOB, everyMs: 24 * 3_600_000 });

  return {
    readEventsAfter: (cursor, limit) => searchSvc.readEventsAfter(ctx, cursor, limit),
    projectForExternal,
    sealPending: (options) => chain.sealPending(options),
    verifyChain: (options) => chain.verify(options),

    search: bind(ctx, searchSvc.search),
    getEvent: bind(ctx, searchSvc.getEvent),
    revealSourceAddress: bind(ctx, searchSvc.revealSourceAddress),
    pivot: bind(ctx, searchSvc.pivot),
    stats: bind(ctx, searchSvc.stats),
    listSavedQueries: bind(ctx, cases.listSavedQueries),
    saveQuery: bind(ctx, cases.saveQuery),
    deleteSavedQuery: bind(ctx, cases.deleteSavedQuery),
    listCases: bind(ctx, cases.listCases),
    getCase: bind(ctx, cases.getCase),
    createCase: bind(ctx, cases.createCase),
    updateCaseStatus: bind(ctx, cases.updateCaseStatus),
    attachEvents: bind(ctx, cases.attachEvents),
    addCaseNote: bind(ctx, cases.addCaseNote),
    requestExport: bind(ctx, exportsSvc.requestExport),
    listExports: bind(ctx, exportsSvc.listExports),
    openExportDownload: bind(ctx, exportsSvc.openExportDownload),
    recordDownloadResult: bind(ctx, exportsSvc.recordDownloadResult),
    integrityStatus: bind(ctx, integrity.integrityStatus),
    verifyIntegrity: bind(ctx, integrity.verifyIntegrity),
    listCheckpoints: bind(ctx, integrity.listCheckpoints),
    createCheckpoint: bind(ctx, integrity.createCheckpointAsAdmin),
    getRetention: bind(ctx, retention.getRetention),
    setRetentionPolicy: bind(ctx, retention.setRetentionPolicy),
    createLegalHold: bind(ctx, retention.createLegalHold),
    releaseLegalHold: bind(ctx, retention.releaseLegalHold),
    runRetention: bind(ctx, retention.runRetentionAsAdmin),

    async health(): Promise<ModuleHealth[]> {
      const checkedAt = deps.clock.now();
      const out: ModuleHealth[] = [];
      const audit = deps.audit;
      if (isDurableAuditEmitter(audit)) {
        const s = audit.stats();
        const recentFailure = s.lastRecordFailureAt !== null && checkedAt.getTime() - Date.parse(s.lastRecordFailureAt) < 5 * 60_000;
        out.push({ component: "audit.store", state: recentFailure ? "degraded" : "ok", summary: recentFailure ? "Recent durable audit write failures" : "Durable audit writes succeeding", metrics: { recorded: s.recorded, failures: s.recordFailures }, checkedAt });
        out.push({ component: "audit.notes", state: s.notesDropped > 0 ? "degraded" : "ok", summary: s.notesDropped > 0 ? "Best-effort notes were dropped" : "Best-effort queue healthy", metrics: { queued: s.notesQueued, dropped: s.notesDropped }, checkedAt });
      }
      try {
        const head = await chain.head();
        const backlog = await chain.unsealedBacklog();
        const ageMs = backlog.oldestObservedAt ? checkedAt.getTime() - backlog.oldestObservedAt.getTime() : 0;
        const state = head.lastVerifyOk === false ? "failing" : ageMs > HORIZON_MS ? "degraded" : "ok";
        out.push({
          component: "audit.chain",
          state,
          summary: head.lastVerifyOk === false ? "Last integrity verification found a break" : state === "degraded" ? "Sealing is behind" : "Hash chain current",
          metrics: { head_seq: head.headSeq, unsealed: backlog.count, oldest_unsealed_age_s: Math.round(ageMs / 1000) },
          checkedAt,
        });
      } catch {
        out.push({ component: "audit.chain", state: "failing", summary: "Audit store unreachable", checkedAt });
      }
      return out;
    },
  };
}
