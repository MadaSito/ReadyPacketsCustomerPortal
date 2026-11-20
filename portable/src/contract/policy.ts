/**
 * Unknown-field policy (normative, see CONTRACT.md §Unknown fields):
 *  - Same or older minor version: records are strict; an unknown top-level key is RECORD_INVALID.
 *  - Newer minor version of the same major: unknown top-level keys are moved, verbatim, into
 *    `heldUnknown` (prefixed with `contract:` when they collide) and counted. Nothing is dropped.
 *  - Unknown keys inside nested objects of a newer minor are not guessed: the record fails validation and
 *    is reported (a reader must not partially interpret a structure it does not understand).
 *  - A different major version is refused (UNSUPPORTED_CONTRACT).
 */
import { knownKeys, type RecordType } from "./records.js";

export interface PolicyResult {
  value: Record<string, unknown>;
  held: number;
}

export function applyUnknownFieldPolicy(type: RecordType, raw: Record<string, unknown>, newerMinor: boolean): PolicyResult {
  if (!newerMinor) return { value: raw, held: 0 };
  const known = knownKeys(type);
  const out: Record<string, unknown> = {};
  const held: Record<string, unknown> =
    raw.heldUnknown && typeof raw.heldUnknown === "object" && !Array.isArray(raw.heldUnknown) ? { ...(raw.heldUnknown as Record<string, unknown>) } : {};
  let count = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (known.has(k)) {
      if (k !== "heldUnknown") out[k] = v;
      continue;
    }
    const key = k in held ? `contract:${k}` : k;
    held[key] = v;
    count += 1;
  }
  if (count > 0 || raw.heldUnknown !== undefined) out.heldUnknown = held;
  return { value: out, held: count };
}
