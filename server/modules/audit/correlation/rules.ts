/**
 * Event correlation rules (increment 06, D7 / ADR 0050). Owner: audit engineer.
 *
 * Pure: classified audit events in, findings out. No I/O, no clock (the caller passes `now`), so every rule
 * and abuse case is unit-tested without a database. The runner (incidents.ts) loads the events, turns
 * findings into incidents and records `security.incident.*`.
 *
 * Every rule uses SLIDING windows (any window of `windowMinutes` inside the loaded range), so a late or delayed
 * run still sees a burst that already ended. Events at or before a subject's "floor" (the close time of the
 * last closed incident for the same rule and subject) are ignored, so closing an incident does not re-open it
 * from the same evidence.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const RULE_KEYS = [
  "brute_force_account",
  "password_spraying",
  "credential_stuffing",
  "distributed_account",
  "success_after_failures",
  "mfa_fatigue",
  "rate_limit_repeated",
  "ban_evasion",
  "privilege_then_export",
] as const;
export type RuleKey = (typeof RULE_KEYS)[number];

export type SubjectKind = "account" | "address" | "user" | "global";

export interface RuleParams {
  enabled: boolean;
  severity: IncidentSeverity;
  /** Main count (failures, accounts, addresses, hits, exports — see RULE_INFO[key].threshold). */
  threshold: number;
  windowMinutes: number;
  /** credential_stuffing only: distinct accounts AND distinct addresses at least this many. */
  distinct: number;
}

export interface CorrelationConfig {
  enabled: boolean;
  /** New evidence within this many minutes of an open/acknowledged incident's last event joins that incident. */
  mergeMinutes: number;
  rules: Record<RuleKey, RuleParams>;
}

export const BOUNDS = {
  threshold: { min: 1, max: 10_000 },
  windowMinutes: { min: 1, max: 1_440 },
  distinct: { min: 1, max: 1_000 },
  mergeMinutes: { min: 5, max: 1_440 },
} as const;

/** Labels for the page and the admin guide (plain language; the threshold label says what is counted). */
export const RULE_INFO: Record<RuleKey, { label: string; description: string; threshold: string; subject: SubjectKind }> = {
  brute_force_account: { label: "Brute force on one account", description: "Many failed sign-in steps for the same account.", threshold: "Failed attempts", subject: "account" },
  password_spraying: { label: "Password spraying", description: "One address fails to sign in to many different accounts.", threshold: "Different accounts", subject: "address" },
  credential_stuffing: { label: "Credential stuffing burst", description: "A burst of failures across many accounts from many addresses.", threshold: "Failed attempts", subject: "global" },
  distributed_account: { label: "Distributed attempts on one account", description: "One account fails to sign in from many different addresses.", threshold: "Different addresses", subject: "account" },
  success_after_failures: { label: "Sign-in after many failures", description: "A successful sign-in right after many failures for the same account (possible compromise).", threshold: "Failures before the sign-in", subject: "account" },
  mfa_fatigue: { label: "MFA fatigue", description: "Repeated failed second-factor or re-authentication proofs for one account.", threshold: "Failed proofs", subject: "account" },
  rate_limit_repeated: { label: "Repeated rate-limit hits", description: "One address keeps hitting the rate limits.", threshold: "Rate-limit hits", subject: "address" },
  ban_evasion: { label: "Ban evasion", description: "An account seen from a banned address is tried again from a new address soon after the ban.", threshold: "Attempts from a new address", subject: "account" },
  privilege_then_export: { label: "Privilege change followed by export", description: "A person whose role changed exports data soon afterwards.", threshold: "Exports", subject: "user" },
};

const rule = (severity: IncidentSeverity, threshold: number, windowMinutes: number, distinct = 1): RuleParams => ({ enabled: true, severity, threshold, windowMinutes, distinct });

export const DEFAULT_CORRELATION_CONFIG: CorrelationConfig = Object.freeze({
  enabled: true,
  mergeMinutes: 60,
  rules: Object.freeze({
    brute_force_account: rule("high", 10, 15),
    password_spraying: rule("high", 5, 10),
    credential_stuffing: rule("critical", 30, 5, 5),
    distributed_account: rule("high", 5, 30),
    success_after_failures: rule("critical", 5, 30),
    mfa_fatigue: rule("high", 5, 10),
    rate_limit_repeated: rule("medium", 5, 15),
    ban_evasion: rule("high", 1, 30),
    privilege_then_export: rule("high", 1, 60),
  }),
}) as CorrelationConfig;

const intIn = (b: { min: number; max: number }) => z.number().int().min(b.min).max(b.max);

/** Strict shape of one rule as written by the page. */
export const ruleParamsSchema = z.strictObject({
  enabled: z.boolean(),
  severity: z.enum(INCIDENT_SEVERITIES),
  threshold: intIn(BOUNDS.threshold),
  windowMinutes: intIn(BOUNDS.windowMinutes),
  distinct: intIn(BOUNDS.distinct),
});

/** Full value written by the service (every rule present). */
export const correlationConfigSchema = z.strictObject({
  enabled: z.boolean(),
  mergeMinutes: intIn(BOUNDS.mergeMinutes),
  rules: z.strictObject(Object.fromEntries(RULE_KEYS.map((k) => [k, ruleParamsSchema])) as Record<RuleKey, typeof ruleParamsSchema>),
});

/**
 * Stored-value schema registered with the settings store: every part optional so older (or partial) stored
 * values keep validating; missing parts come from the defaults in `parseCorrelationConfig`.
 */
export type StoredCorrelationConfig = { enabled?: boolean; mergeMinutes?: number; rules?: Partial<Record<RuleKey, Partial<RuleParams>>> };
export const storedCorrelationConfigSchema = z.strictObject({
  enabled: z.boolean().optional(),
  mergeMinutes: intIn(BOUNDS.mergeMinutes).optional(),
  rules: z.strictObject(Object.fromEntries(RULE_KEYS.map((k) => [k, ruleParamsSchema.partial().optional()]))).optional(),
}) as unknown as z.ZodType<StoredCorrelationConfig>;

/** Never throws: unknown or invalid parts fall back to the default, field by field. */
export function parseCorrelationConfig(raw: unknown): CorrelationConfig {
  const base = DEFAULT_CORRELATION_CONFIG;
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pick = <T>(schema: z.ZodType<T>, value: unknown, fallback: T): T => {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : fallback;
  };
  const rulesSrc = src.rules && typeof src.rules === "object" ? (src.rules as Record<string, unknown>) : {};
  const rules = {} as Record<RuleKey, RuleParams>;
  for (const key of RULE_KEYS) {
    const d = base.rules[key];
    const r = rulesSrc[key] && typeof rulesSrc[key] === "object" ? (rulesSrc[key] as Record<string, unknown>) : {};
    rules[key] = {
      enabled: pick(z.boolean(), r.enabled, d.enabled),
      severity: pick(z.enum(INCIDENT_SEVERITIES), r.severity, d.severity),
      threshold: pick(intIn(BOUNDS.threshold), r.threshold, d.threshold),
      windowMinutes: pick(intIn(BOUNDS.windowMinutes), r.windowMinutes, d.windowMinutes),
      distinct: pick(intIn(BOUNDS.distinct), r.distinct, d.distinct),
    };
  }
  return { enabled: pick(z.boolean(), src.enabled, base.enabled), mergeMinutes: pick(intIn(BOUNDS.mergeMinutes), src.mergeMinutes, base.mergeMinutes), rules };
}

/* ------------------------------------------------------------------------------------------ events */

export type SignalKind = "signin_failure" | "mfa_failure" | "signin_success" | "rate_limited" | "ban_created" | "privilege_change" | "export";

export interface CorrelationEvent {
  eventId: string;
  /** Epoch milliseconds. */
  at: number;
  name: string;
  kind: SignalKind;
  /** Request source-address pseudonym (audit `source_address_ref`). */
  addressRef: string | null;
  /** Account key: identity's `account_ref` blind index, or `user:<publicId>` when only the user is known. */
  accountKey: string | null;
  /** Target user (sign-in / privilege events) or acting user (exports), public id. */
  userPublicId: string | null;
  /** ban_created only: the banned address pseudonym. */
  banAddressRef: string | null;
}

export interface Finding {
  ruleKey: RuleKey;
  severity: IncidentSeverity;
  subjectKind: SubjectKind;
  subjectRef: string;
  dedupeKey: string;
  eventIds: string[];
  firstAt: number;
  lastAt: number;
  eventCount: number;
  accountCount: number;
  addressCount: number;
  userPublicId: string | null;
  /** Correlated event whose source address a ban would target (most frequent address; latest such event). */
  addressEventId: string | null;
}

export function dedupeKeyOf(ruleKey: RuleKey, subjectKind: SubjectKind, subjectRef: string): string {
  return createHash("sha256").update(`rp.security.incident/1|${ruleKey}|${subjectKind}|${subjectRef}`).digest("hex");
}

const MIN = 60_000;
const isFailure = (e: CorrelationEvent) => e.kind === "signin_failure" || e.kind === "mfa_failure";
const isSignInAttempt = (e: CorrelationEvent) => isFailure(e) || e.kind === "signin_success";

function groupBy<T>(items: readonly T[], key: (item: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/**
 * Marks every event that lies in at least one window of `windowMs` meeting the minimum count and the minimum
 * number of distinct values per key function. `events` must be sorted by time. O(n) with incremental counters.
 */
export function slidingQualify(
  events: readonly CorrelationEvent[],
  windowMs: number,
  minCount: number,
  distinct: ReadonlyArray<{ key: (e: CorrelationEvent) => string | null; min: number }> = [],
): CorrelationEvent[] {
  const counters = distinct.map(() => new Map<string, number>());
  const marked: CorrelationEvent[] = [];
  let left = 0;
  let lastMarked = -1;
  const add = (e: CorrelationEvent, delta: 1 | -1) => {
    distinct.forEach((d, i) => {
      const k = d.key(e);
      if (k === null) return;
      const m = counters[i]!;
      const next = (m.get(k) ?? 0) + delta;
      if (next <= 0) m.delete(k);
      else m.set(k, next);
    });
  };
  for (let right = 0; right < events.length; right += 1) {
    const current = events[right]!;
    add(current, 1);
    while (current.at - events[left]!.at > windowMs) {
      add(events[left]!, -1);
      left += 1;
    }
    const count = right - left + 1;
    const ok = count >= minCount && distinct.every((d, i) => counters[i]!.size >= d.min);
    if (ok) {
      for (let i = Math.max(left, lastMarked + 1); i <= right; i += 1) marked.push(events[i]!);
      lastMarked = right;
    }
  }
  return marked;
}

const LEVEL: Record<IncidentSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export function maxSeverity(a: IncidentSeverity, b: IncidentSeverity): IncidentSeverity {
  return LEVEL[a] >= LEVEL[b] ? a : b;
}
/** One level up once the evidence reaches three times the threshold. */
export function escalated(base: IncidentSeverity, count: number, threshold: number): IncidentSeverity {
  return count >= threshold * 3 ? INCIDENT_SEVERITIES[Math.min(3, LEVEL[base] + 1)]! : base;
}

function finding(ruleKey: RuleKey, params: RuleParams, subjectKind: SubjectKind, subjectRef: string, events: CorrelationEvent[], countForSeverity: number): Finding {
  const sorted = [...events].sort((a, b) => a.at - b.at || (a.eventId < b.eventId ? -1 : 1));
  const accounts = new Set(sorted.map((e) => e.accountKey).filter((v): v is string => v !== null));
  const addresses = new Map<string, number>();
  for (const e of sorted) if (e.addressRef) addresses.set(e.addressRef, (addresses.get(e.addressRef) ?? 0) + 1);
  let topAddress: string | null = null;
  for (const [ref, n] of addresses) if (topAddress === null || n > addresses.get(topAddress)!) topAddress = ref;
  const addressEvent = topAddress ? [...sorted].reverse().find((e) => e.addressRef === topAddress && e.kind !== "ban_created") ?? null : null;
  const user = [...sorted].reverse().find((e) => e.userPublicId !== null)?.userPublicId ?? null;
  return {
    ruleKey,
    severity: escalated(params.severity, countForSeverity, params.threshold),
    subjectKind,
    subjectRef,
    dedupeKey: dedupeKeyOf(ruleKey, subjectKind, subjectRef),
    eventIds: sorted.map((e) => e.eventId),
    firstAt: sorted[0]!.at,
    lastAt: sorted[sorted.length - 1]!.at,
    eventCount: sorted.length,
    accountCount: accounts.size,
    addressCount: addresses.size,
    userPublicId: subjectKind === "global" ? null : user,
    addressEventId: addressEvent?.eventId ?? null,
  };
}

export interface EvaluateOptions {
  /** Close time (epoch ms) of the last closed incident per dedupe key. */
  floors?: ReadonlyMap<string, number>;
}

/** Evaluates every enabled rule. `events` may be in any order. */
export function evaluateRules(input: readonly CorrelationEvent[], config: CorrelationConfig, options: EvaluateOptions = {}): Finding[] {
  if (!config.enabled) return [];
  const events = [...input].sort((a, b) => a.at - b.at || (a.eventId < b.eventId ? -1 : 1));
  const floors = options.floors ?? new Map<string, number>();
  const above = (ruleKey: RuleKey, kind: SubjectKind, ref: string, list: CorrelationEvent[]) => {
    const floor = floors.get(dedupeKeyOf(ruleKey, kind, ref));
    return floor === undefined ? list : list.filter((e) => e.at > floor);
  };
  const out: Finding[] = [];
  const failures = events.filter(isFailure);
  const R = config.rules;

  const perSubject = (
    ruleKey: RuleKey,
    kind: SubjectKind,
    source: CorrelationEvent[],
    subjectOf: (e: CorrelationEvent) => string | null,
    distinct: (p: RuleParams) => Array<{ key: (e: CorrelationEvent) => string | null; min: number }>,
    minCount: (p: RuleParams) => number,
    severityCount: (marked: CorrelationEvent[]) => number,
  ) => {
    const p = R[ruleKey];
    if (!p.enabled) return;
    for (const [ref, list] of groupBy(source, subjectOf)) {
      const marked = slidingQualify(above(ruleKey, kind, ref, list), p.windowMinutes * MIN, minCount(p), distinct(p));
      if (marked.length > 0) out.push(finding(ruleKey, p, kind, ref, marked, severityCount(marked)));
    }
  };
  const distinctCount = (key: (e: CorrelationEvent) => string | null) => (marked: CorrelationEvent[]) => new Set(marked.map(key).filter((v) => v !== null)).size;

  perSubject("brute_force_account", "account", failures, (e) => e.accountKey, () => [], (p) => p.threshold, (m) => m.length);
  perSubject("password_spraying", "address", failures, (e) => e.addressRef, (p) => [{ key: (e) => e.accountKey, min: p.threshold }], () => 1, distinctCount((e) => e.accountKey));
  perSubject("distributed_account", "account", failures, (e) => e.accountKey, (p) => [{ key: (e) => e.addressRef, min: p.threshold }], () => 1, distinctCount((e) => e.addressRef));
  perSubject(
    "credential_stuffing",
    "global",
    failures,
    () => "all",
    (p) => [{ key: (e) => e.accountKey, min: p.distinct }, { key: (e) => e.addressRef, min: p.distinct }],
    (p) => p.threshold,
    (m) => m.length,
  );
  perSubject("mfa_fatigue", "account", events.filter((e) => e.kind === "mfa_failure"), (e) => e.accountKey, () => [], (p) => p.threshold, (m) => m.length);
  perSubject("rate_limit_repeated", "address", events.filter((e) => e.kind === "rate_limited"), (e) => e.addressRef, () => [], (p) => p.threshold, (m) => m.length);

  /* Sign-in after many failures: a success preceded by >= threshold failures for the same account. */
  const sap = R.success_after_failures;
  if (sap.enabled) {
    const failuresByAccount = groupBy(failures, (e) => e.accountKey);
    for (const [account, successes] of groupBy(events.filter((e) => e.kind === "signin_success"), (e) => e.accountKey)) {
      const fails = failuresByAccount.get(account) ?? [];
      const evidence = new Map<string, CorrelationEvent>();
      let worst = 0;
      for (const s of above("success_after_failures", "account", account, successes)) {
        const before = fails.filter((f) => f.at <= s.at && s.at - f.at <= sap.windowMinutes * MIN && f.eventId !== s.eventId);
        if (before.length >= sap.threshold) {
          worst = Math.max(worst, before.length);
          for (const e of [...before, s]) evidence.set(e.eventId, e);
        }
      }
      if (evidence.size > 0) out.push(finding("success_after_failures", sap, "account", account, [...evidence.values()], worst));
    }
  }

  /* Ban evasion: accounts that failed from the banned address are tried again from another address after the ban. */
  const be = R.ban_evasion;
  if (be.enabled) {
    const perAccount = new Map<string, Map<string, CorrelationEvent>>();
    for (const ban of events.filter((e) => e.kind === "ban_created" && e.banAddressRef !== null)) {
      const windowMs = be.windowMinutes * MIN;
      const accounts = new Set(
        failures.filter((f) => f.addressRef === ban.banAddressRef && f.accountKey !== null && f.at <= ban.at && ban.at - f.at <= windowMs).map((f) => f.accountKey!),
      );
      for (const account of accounts) {
        const later = events.filter(
          (e) => isSignInAttempt(e) && e.accountKey === account && e.addressRef !== null && e.addressRef !== ban.banAddressRef && e.at > ban.at && e.at - ban.at <= windowMs,
        );
        const fresh = above("ban_evasion", "account", account, later);
        if (fresh.length < be.threshold) continue;
        const bucket = perAccount.get(account) ?? new Map<string, CorrelationEvent>();
        for (const e of [ban, ...fresh]) bucket.set(e.eventId, e);
        perAccount.set(account, bucket);
      }
    }
    for (const [account, bucket] of perAccount) {
      const list = [...bucket.values()];
      out.push(finding("ban_evasion", be, "account", account, list, list.filter((e) => e.kind !== "ban_created").length));
    }
  }

  /* Privilege change followed by export by the same person. */
  const pe = R.privilege_then_export;
  if (pe.enabled) {
    const exportsByUser = groupBy(events.filter((e) => e.kind === "export"), (e) => e.userPublicId);
    for (const [user, changes] of groupBy(events.filter((e) => e.kind === "privilege_change"), (e) => e.userPublicId)) {
      const evidence = new Map<string, CorrelationEvent>();
      let worst = 0;
      for (const change of changes) {
        const exportsAfter = above("privilege_then_export", "user", user, (exportsByUser.get(user) ?? []).filter((x) => x.at > change.at && x.at - change.at <= pe.windowMinutes * MIN));
        if (exportsAfter.length >= pe.threshold) {
          worst = Math.max(worst, exportsAfter.length);
          for (const e of [change, ...exportsAfter]) evidence.set(e.eventId, e);
        }
      }
      if (evidence.size > 0) out.push(finding("privilege_then_export", pe, "user", user, [...evidence.values()], worst));
    }
  }
  return out;
}

/** Longest range the runner must load so every enabled rule sees a full window (ban evasion and the sliding windows look back and forward). */
export function lookbackMinutes(config: CorrelationConfig): number {
  let max = 0;
  for (const key of RULE_KEYS) if (config.rules[key].enabled) max = Math.max(max, config.rules[key].windowMinutes * 2);
  return Math.min(2 * BOUNDS.windowMinutes.max, Math.max(max, 10));
}
