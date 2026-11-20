import { createHmac, hkdfSync } from "node:crypto";

const SLOT_COUNT = 1 << 16;
export const EDGE_REQUESTS_PER_WINDOW = 120;
const WINDOW_MS = 10_000;
const NOTE_WINDOW_MS = 60_000;

/** Bounded process-local pre-gate. Durable cross-replica budgets are enforced independently. */
export function createEdgeAdmission(root: Buffer) {
  const key = Buffer.from(hkdfSync("sha256", root, "", "readypackets/http/pre-admission/v1", 32));
  const starts = new Float64Array(SLOT_COUNT);
  const counts = new Uint16Array(SLOT_COUNT);
  const noteStarts = new Float64Array(SLOT_COUNT);
  const noteKinds = new Uint8Array(SLOT_COUNT);
  const indexFor = (address: string) => createHmac("sha256", key).update(address).digest().readUInt16BE();
  return {
    consume(address: string, now: number): number {
      const slot = indexFor(address);
      if (counts[slot] === 0 || now < starts[slot]! || now - starts[slot]! >= WINDOW_MS) {
        starts[slot] = now;
        counts[slot] = 1;
      } else if (counts[slot]! >= EDGE_REQUESTS_PER_WINDOW) {
        return Math.max(1, Math.ceil((starts[slot]! + WINDOW_MS - now) / 1000));
      } else {
        counts[slot]!++;
      }
      return 0;
    },
    shouldNote(address: string, now: number, kind: 1 | 2): boolean {
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
