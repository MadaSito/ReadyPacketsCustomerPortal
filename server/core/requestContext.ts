import { AsyncLocalStorage } from "node:async_hooks";
import { randomHex, ulid } from "./ids.js";
import type { RequestContext } from "./types.js";

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Mutates the active context once the session is resolved (same async chain). */
export function setRequestActor(actor: RequestContext["actor"]): void {
  const store = storage.getStore();
  if (store) store.actor = actor;
}

export function newRequestContext(
  origin: RequestContext["origin"],
  partial: Partial<RequestContext> = {},
): RequestContext {
  return {
    requestId: ulid(),
    traceId: randomHex(16),
    spanId: randomHex(8),
    origin,
    startedAt: new Date(),
    ...partial,
  };
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/**
 * Accepts an inbound W3C `traceparent` ONLY when the edge is a configured trusted proxy and the value is
 * well-formed and non-zero; otherwise a fresh trace is generated. The request ID is always server-generated.
 */
export function traceFromHeader(header: string | undefined, trusted: boolean): { traceId: string; spanId: string } {
  if (trusted && header) {
    const match = TRACEPARENT.exec(header.trim());
    if (match && !/^0+$/.test(match[1]!) && !/^0+$/.test(match[2]!)) {
      return { traceId: match[1]!, spanId: randomHex(8) };
    }
  }
  return { traceId: randomHex(16), spanId: randomHex(8) };
}
