import { createHmac, hkdfSync } from "node:crypto";
import type { RateLimitCategory } from "../core/types.js";

const SLOT_COUNT = 1 << 16;
export const EDGE_REQUESTS_PER_WINDOW = 120;
export const EDGE_STATIC_PER_WINDOW = 900;
const WINDOW_MS = 10_000;
const NOTE_WINDOW_MS = 60_000;
export type AdmissionBucket = "edge_requests" | "edge_static";
export type RateLimitBucket = AdmissionBucket | RateLimitCategory | "unclassified";

/** Only canonical, flat, read-only build/static paths get the separate budget. */
export function edgeAdmissionBucket(method: string, path: string): AdmissionBucket {
  if ((method !== "GET" && method !== "HEAD") || path.length > 256) return "edge_requests";
  if (/^\/assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*-[A-Za-z0-9_-]{8,}\.(?:m?js|css|woff2?|png|svg|webp|avif|ico|jpe?g|gif|wasm)$/u.test(path) ||
      /^\/fonts\/[A-Za-z0-9_-]+\.woff2?$/u.test(path) ||
      /^\/brand\/[A-Za-z0-9_-]+\.(?:png|svg|webp|avif|ico|jpe?g)$/u.test(path)) return "edge_static";
  return "edge_requests";
}

/** Bounded process-local pre-gate. Durable cross-replica budgets are enforced independently. */
export function createEdgeAdmission(root: Buffer) {
  const key = Buffer.from(hkdfSync("sha256", root, "", "readypackets/http/pre-admission/v1", 32));
  const counters = {
    edge_requests: { starts: new Float64Array(SLOT_COUNT), counts: new Uint16Array(SLOT_COUNT), limit: EDGE_REQUESTS_PER_WINDOW },
    edge_static: { starts: new Float64Array(SLOT_COUNT), counts: new Uint16Array(SLOT_COUNT), limit: EDGE_STATIC_PER_WINDOW },
  };
  const noteStarts = new Float64Array(SLOT_COUNT);
  const noteKinds = new Uint8Array(SLOT_COUNT);
  const indexFor = (address: string) => createHmac("sha256", key).update(address).digest().readUInt16BE();
  return {
    consume(address: string, now: number, bucket: AdmissionBucket): number {
      const { starts, counts, limit } = counters[bucket];
      const slot = indexFor(address);
      if (counts[slot] === 0 || now < starts[slot]! || now - starts[slot]! >= WINDOW_MS) {
        starts[slot] = now;
        counts[slot] = 1;
      } else if (counts[slot]! >= limit) {
        return Math.max(1, Math.ceil((starts[slot]! + WINDOW_MS - now) / 1000));
      } else {
        counts[slot]!++;
      }
      return 0;
    },
    shouldNote(address: string, now: number, kind: 1 | 2 | 4): boolean {
      const slot = indexFor(address);
      if (now < noteStarts[slot]! || now - noteStarts[slot]! >= NOTE_WINDOW_MS) {
        noteStarts[slot] = now;
        noteKinds[slot] = 0;
      }
      if (noteKinds[slot]! & kind) return false;
      noteKinds[slot]! |= kind;
      return true;
    },
  };
}
