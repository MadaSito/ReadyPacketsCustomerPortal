import { jsonDepth } from "./json.js";
import type { PortableLimits } from "./limits.js";
import { RECORD_SCHEMAS, type RecordType } from "./contract/records.js";
import { scanExclusions } from "./contract/exclusions.js";
import { applyUnknownFieldPolicy } from "./contract/policy.js";
import type { VerificationIssue } from "./types.js";

/** Validate one decoded record value (shared by v3 reader and legacy adapters). */
export function checkRecord(
  type: RecordType,
  raw: unknown,
  newerMinor: boolean,
  limits: PortableLimits,
): { ok: true; value: Record<string, unknown>; held: number } | { ok: false; issue: VerificationIssue } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, issue: { code: "RECORD_INVALID", message: "A record line is not a JSON object.", recordType: type } };
  if (jsonDepth(raw) > 32) return { ok: false, issue: { code: "RECORD_INVALID", message: "A record is nested too deeply.", recordType: type } };
  const hits = scanExclusions(raw);
  if (hits.length) return { ok: false, issue: { code: "EXCLUDED_FIELD", message: "A record contains a field or value that must never be exported.", recordType: type, path: hits[0]!.path } };
  const { value, held } = applyUnknownFieldPolicy(type, raw as Record<string, unknown>, newerMinor);
  const parsed = RECORD_SCHEMAS[type].safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, issue: { code: "RECORD_INVALID", message: "A record does not match the portable contract.", recordType: type, path: issue ? `/${issue.path.map(String).join("/")}` : "" } };
  }
  const data = parsed.data as Record<string, unknown>;
  if (data.heldUnknown !== undefined && Buffer.byteLength(JSON.stringify(data.heldUnknown)) > limits.maxHeldUnknownBytes) {
    return { ok: false, issue: { code: "RECORD_INVALID", message: "Held-unknown content exceeds its size limit.", recordType: type, path: "/heldUnknown" } };
  }
  void held;
  const heldCount = data.heldUnknown ? Object.keys(data.heldUnknown).length : 0;
  return { ok: true, value: data, held: heldCount };
}

