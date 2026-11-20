import { setTimeout as delay } from "node:timers/promises";
import { DomainError } from "../../core/errors.js";
import type { ActiveClaim, JobEngine } from "./queue.js";

export interface WorkerHandle {
  /** Rejects if in-flight work could not be safely settled; the caller must not assume drain. */
  stop(): Promise<void>;
}

const POLL_MS = 250;
const HOUSEKEEPING_MS = 1_000;
const HEARTBEAT_MS = 6_000;
const CONCURRENCY = 2;
const GRACE_MS = 12_000;
const ABORT_SETTLE_MS = 3_000;

export function startWorker(engine: JobEngine): WorkerHandle {
  const { clock, logger } = engine.deps;
  let stopping = false;
  let inFlightTick: Promise<void> | undefined;
  let inFlightHeartbeat: Promise<void> | undefined;
  let stopResult: Promise<void> | undefined;
  let nextHousekeeping = Number.NEGATIVE_INFINITY;
  const active = new Map<ActiveClaim, Promise<void>>();
  const unresolved = new Set<ActiveClaim>();
  let unconfirmed = false;

  async function pump() {
    if (stopping) return;
    if (clock.now().getTime() >= nextHousekeeping) {
      nextHousekeeping = clock.now().getTime() + HOUSEKEEPING_MS;
      try {
        await engine.reap();
        if (!stopping) await engine.scheduleTick();
        if (!stopping && unresolved.size > 0) {
          for (const claim of unresolved) {
            // When no owned fence survives, the stale-lease reaper is authoritative.
            await engine.interrupt(claim, "JOB_SETTLEMENT_INTERRUPTED");
            unresolved.delete(claim);
          }
        }
      } catch {
        logger.warn("job housekeeping unavailable", { component: "jobs.queue" });
      }
    }
    while (!stopping && active.size + unresolved.size < CONCURRENCY) {
      const claim = await engine.claim();
      if (!claim) return;
      if (stopping) {
        // A claim may return after stop was requested; do not invoke its handler.
        try {
          if (!await engine.finish(claim, { outcome: "failed", reasonCode: "JOB_NOT_STARTED", retryable: true })) {
            unconfirmed = true;
          }
        } catch {
          unconfirmed = true;
        }
        return;
      }
      const run = engine.execute(claim).catch(() => {
        claim.controller.abort();
        unresolved.add(claim);
        logger.error("job disposition unavailable", { component: "jobs.queue" });
      }).finally(() => active.delete(claim));
      active.set(claim, run);
    }
  }

  function kick() {
    if (stopping || inFlightTick) return;
    inFlightTick = pump().catch(() => {
      logger.warn("job claim unavailable", { component: "jobs.queue" });
    }).finally(() => { inFlightTick = undefined; });
  }

  const pollTimer = setInterval(kick, POLL_MS);
  const heartbeatTimer = setInterval(() => {
    if (!inFlightHeartbeat && active.size > 0) {
      inFlightHeartbeat = Promise.all(Array.from(active.keys(), (claim) => engine.heartbeat(claim)))
        .then(() => {})
        .finally(() => { inFlightHeartbeat = undefined; });
    }
  }, HEARTBEAT_MS);
  kick();

  const settled = async (ms: number) => {
    const timer = new AbortController();
    try {
      return await Promise.race([
        Promise.all([inFlightTick, inFlightHeartbeat, ...active.values()]).then(() => true),
        delay(ms, false, { signal: timer.signal }),
      ]);
    } finally {
      timer.abort();
    }
  };

  async function stopOnce() {
    stopping = true;
    clearInterval(pollTimer);
    try {
      if (!await settled(GRACE_MS)) {
        for (const claim of active.keys()) claim.controller.abort();
        await settled(ABORT_SETTLE_MS);
      }
    } finally {
      clearInterval(heartbeatTimer);
    }
    const interrupted = [...active.keys(), ...unresolved];
    const timer = new AbortController();
    try {
      const confirmed = await Promise.race([
        Promise.all(interrupted.map(async (claim) => {
          try { return await engine.interrupt(claim); } catch { return false; }
        })).then((results) => results.every(Boolean)),
        delay(ABORT_SETTLE_MS, false, { signal: timer.signal }),
      ]);
      if (!confirmed || unconfirmed || active.size > 0 || inFlightTick || inFlightHeartbeat) {
        throw new DomainError("UNKNOWN_OUTCOME", "WORKER_STOP_UNPROVED", "The worker could not confirm that all work stopped.");
      }
    } finally {
      timer.abort();
    }
  }

  return { stop: () => stopResult ??= stopOnce() };
}
