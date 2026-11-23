/** Correlation rules (D7): every rule, sliding windows, floors, abuse cases, old stored values. Synthetic data only. */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CORRELATION_CONFIG,
  dedupeKeyOf,
  escalated,
  evaluateRules,
  lookbackMinutes,
  parseCorrelationConfig,
  storedCorrelationConfigSchema,
  type CorrelationConfig,
  type CorrelationEvent,
  type RuleKey,
  type SignalKind,
} from "./rules.js";

const MIN = 60_000;
const T0 = Date.parse("2026-11-23T10:00:00.000Z");
let seq = 0;
const hex = (prefix: string) => (prefix + "0".repeat(32)).slice(0, 32);
function ev(kind: SignalKind, minute: number, opts: Partial<CorrelationEvent> = {}): CorrelationEvent {
  seq += 1;
  return {
    eventId: `01JE${String(seq).padStart(22, "0")}`,
    at: T0 + minute * MIN,
    name: kind,
    kind,
    addressRef: opts.addressRef === undefined ? hex("a1") : opts.addressRef,
    accountKey: opts.accountKey === undefined ? "acct-1" : opts.accountKey,
    userPublicId: opts.userPublicId ?? null,
    banAddressRef: opts.banAddressRef ?? null,
    ...opts,
  };
}
const only = (key: RuleKey): CorrelationConfig => ({
  ...DEFAULT_CORRELATION_CONFIG,
  rules: Object.fromEntries(Object.entries(DEFAULT_CORRELATION_CONFIG.rules).map(([k, v]) => [k, { ...v, enabled: k === key }])) as CorrelationConfig["rules"],
});
const withRule = (key: RuleKey, patch: Partial<CorrelationConfig["rules"][RuleKey]>): CorrelationConfig => {
  const c = only(key);
  return { ...c, rules: { ...c.rules, [key]: { ...c.rules[key], ...patch } } };
};
const times = (n: number, f: (i: number) => CorrelationEvent) => Array.from({ length: n }, (_, i) => f(i));

describe("brute force on one account", () => {
  it("fires at the threshold inside the window and not below it", () => {
    const nine = times(9, (i) => ev("signin_failure", i));
    expect(evaluateRules(nine, only("brute_force_account"))).toHaveLength(0);
    const ten = [...nine, ev("signin_failure", 9)];
    const [f] = evaluateRules(ten, only("brute_force_account"));
    expect(f).toMatchObject({ ruleKey: "brute_force_account", subjectKind: "account", subjectRef: "acct-1", eventCount: 10, severity: "high" });
  });
  it("uses a sliding window: spread-out failures never qualify, a later burst does", () => {
    const spread = times(10, (i) => ev("signin_failure", i * 20));
    expect(evaluateRules(spread, only("brute_force_account"))).toHaveLength(0);
    const burst = times(10, (i) => ev("signin_failure", 500 + i));
    const [f] = evaluateRules([...spread, ...burst], only("brute_force_account"));
    expect(f!.eventCount).toBe(10);
    expect(f!.firstAt).toBe(T0 + 500 * MIN);
  });
  it("counts MFA failures with password failures", () => {
    const mixed = [...times(5, (i) => ev("signin_failure", i)), ...times(5, (i) => ev("mfa_failure", i))];
    expect(evaluateRules(mixed, only("brute_force_account"))).toHaveLength(1);
  });
  it("escalates one level at three times the threshold", () => {
    const [f] = evaluateRules(times(30, (i) => ev("signin_failure", i * 0.3)), only("brute_force_account"));
    expect(f!.severity).toBe("critical");
    expect(escalated("critical", 100, 1)).toBe("critical");
  });
  it("ignores evidence at or before the close time of the last incident for the same subject", () => {
    const events = times(10, (i) => ev("signin_failure", i));
    const floors = new Map([[dedupeKeyOf("brute_force_account", "account", "acct-1"), T0 + 9 * MIN]]);
    expect(evaluateRules(events, only("brute_force_account"), { floors })).toHaveLength(0);
  });
  it("a bad sign-in for another account is a separate subject (bans are per address, incidents per account)", () => {
    const a = times(6, (i) => ev("signin_failure", i, { accountKey: "acct-a" }));
    const b = times(6, (i) => ev("signin_failure", i, { accountKey: "acct-b" }));
    expect(evaluateRules([...a, ...b], only("brute_force_account"))).toHaveLength(0);
  });
});

describe("password spraying and distributed attempts", () => {
  it("one address, many accounts", () => {
    const events = times(5, (i) => ev("signin_failure", i, { accountKey: `acct-${i}` }));
    const [f] = evaluateRules(events, only("password_spraying"));
    expect(f).toMatchObject({ subjectKind: "address", subjectRef: hex("a1"), accountCount: 5, addressCount: 1 });
    expect(f!.addressEventId).toBe(events[4]!.eventId);
    expect(evaluateRules(events.slice(0, 4), only("password_spraying"))).toHaveLength(0);
  });
  it("one account, many addresses", () => {
    const events = times(5, (i) => ev("signin_failure", i, { addressRef: hex(`b${i}`) }));
    const [f] = evaluateRules(events, only("distributed_account"));
    expect(f).toMatchObject({ subjectKind: "account", addressCount: 5 });
  });
  it("events without an address (unknown client address) never count as distinct addresses", () => {
    const events = times(8, (i) => ev("signin_failure", i, { addressRef: null, accountKey: `acct-${i}` }));
    expect(evaluateRules(events, only("password_spraying"))).toHaveLength(0);
    expect(evaluateRules(events, only("distributed_account"))).toHaveLength(0);
  });
});

describe("credential stuffing burst", () => {
  it("needs the failure count AND distinct accounts AND distinct addresses in the window", () => {
    const burst = times(30, (i) => ev("signin_failure", i * 0.1, { accountKey: `acct-${i % 10}`, addressRef: hex(`c${i % 6}`) }));
    const [f] = evaluateRules(burst, only("credential_stuffing"));
    expect(f).toMatchObject({ subjectKind: "global", subjectRef: "all", severity: "critical", userPublicId: null });
    const oneAddress = times(30, (i) => ev("signin_failure", i * 0.1, { accountKey: `acct-${i % 10}` }));
    expect(evaluateRules(oneAddress, only("credential_stuffing"))).toHaveLength(0);
  });
});

describe("sign-in after many failures", () => {
  it("flags a success that follows enough failures, with the user for 'End sessions'", () => {
    const events = [...times(5, (i) => ev("signin_failure", i)), ev("signin_success", 6, { userPublicId: "01JEUSER00000000000000000A" })];
    const [f] = evaluateRules(events, only("success_after_failures"));
    expect(f).toMatchObject({ ruleKey: "success_after_failures", severity: "critical", eventCount: 6, userPublicId: "01JEUSER00000000000000000A" });
  });
  it("does not flag a success when the failures are older than the window or belong to someone else", () => {
    const old = [...times(5, (i) => ev("signin_failure", i)), ev("signin_success", 100)];
    expect(evaluateRules(old, only("success_after_failures"))).toHaveLength(0);
    const other = [...times(5, (i) => ev("signin_failure", i, { accountKey: "acct-x" })), ev("signin_success", 6)];
    expect(evaluateRules(other, only("success_after_failures"))).toHaveLength(0);
  });
});

describe("MFA fatigue and rate-limit hits", () => {
  it("MFA fatigue counts second-factor failures only", () => {
    expect(evaluateRules(times(5, (i) => ev("signin_failure", i)), only("mfa_fatigue"))).toHaveLength(0);
    expect(evaluateRules(times(5, (i) => ev("mfa_failure", i)), only("mfa_fatigue"))).toHaveLength(1);
  });
  it("repeated rate-limit hits per address", () => {
    const [f] = evaluateRules(times(5, (i) => ev("rate_limited", i, { accountKey: null })), only("rate_limit_repeated"));
    expect(f).toMatchObject({ subjectKind: "address", severity: "medium" });
  });
});

describe("ban evasion", () => {
  const banned = hex("dd");
  it("an account that failed from the banned address is tried from a new address after the ban", () => {
    const events = [
      ...times(3, (i) => ev("signin_failure", i, { addressRef: banned })),
      ev("ban_created", 4, { addressRef: null, accountKey: null, banAddressRef: banned }),
      ev("signin_failure", 6, { addressRef: hex("ee") }),
    ];
    const [f] = evaluateRules(events, only("ban_evasion"));
    expect(f).toMatchObject({ ruleKey: "ban_evasion", subjectRef: "acct-1", eventCount: 2 });
    expect(f!.addressEventId).toBe(events[4]!.eventId);
  });
  it("attempts from the banned address itself, before the ban, or for other accounts are not evasion", () => {
    const events = [
      ev("signin_failure", 0, { addressRef: banned }),
      ev("signin_failure", 1, { addressRef: hex("ee") }),
      ev("ban_created", 2, { addressRef: null, accountKey: null, banAddressRef: banned }),
      ev("signin_failure", 3, { addressRef: banned }),
      ev("signin_failure", 4, { addressRef: hex("ef"), accountKey: "acct-other" }),
    ];
    expect(evaluateRules(events, only("ban_evasion"))).toHaveLength(0);
  });
});

describe("privilege change followed by export", () => {
  const user = "01JEUSER00000000000000000B";
  it("flags an export by the same person inside the window", () => {
    const events = [ev("privilege_change", 0, { userPublicId: user, accountKey: null }), ev("export", 30, { userPublicId: user, accountKey: null })];
    const [f] = evaluateRules(events, only("privilege_then_export"));
    expect(f).toMatchObject({ subjectKind: "user", subjectRef: user, userPublicId: user });
  });
  it("ignores exports before the change, after the window, or by someone else", () => {
    const events = [
      ev("export", -5, { userPublicId: user, accountKey: null }),
      ev("privilege_change", 0, { userPublicId: user, accountKey: null }),
      ev("export", 61, { userPublicId: user, accountKey: null }),
      ev("export", 10, { userPublicId: "01JEUSER00000000000000000C", accountKey: null }),
    ];
    expect(evaluateRules(events, only("privilege_then_export"))).toHaveLength(0);
  });
});

describe("configuration", () => {
  it("a disabled rule or a disabled engine produces nothing", () => {
    const events = times(10, (i) => ev("signin_failure", i));
    expect(evaluateRules(events, withRule("brute_force_account", { enabled: false }))).toHaveLength(0);
    expect(evaluateRules(events, { ...only("brute_force_account"), enabled: false })).toHaveLength(0);
  });
  it("editable thresholds are honoured", () => {
    const events = times(3, (i) => ev("signin_failure", i));
    expect(evaluateRules(events, withRule("brute_force_account", { threshold: 3, windowMinutes: 5 }))).toHaveLength(1);
  });
  it("old, partial or invalid stored values parse with defaults and never throw", () => {
    expect(parseCorrelationConfig(undefined)).toEqual(DEFAULT_CORRELATION_CONFIG);
    expect(parseCorrelationConfig("garbage")).toEqual(DEFAULT_CORRELATION_CONFIG);
    const partial = parseCorrelationConfig({ rules: { mfa_fatigue: { threshold: 9 }, unknown_rule: { threshold: 1 } }, mergeMinutes: -3 });
    expect(partial.rules.mfa_fatigue).toEqual({ ...DEFAULT_CORRELATION_CONFIG.rules.mfa_fatigue, threshold: 9 });
    expect(partial.mergeMinutes).toBe(60);
    const bad = parseCorrelationConfig({ rules: { brute_force_account: { threshold: 0, severity: "extreme", windowMinutes: 99999 } } });
    expect(bad.rules.brute_force_account).toEqual(DEFAULT_CORRELATION_CONFIG.rules.brute_force_account);
    expect(storedCorrelationConfigSchema.safeParse({ rules: { mfa_fatigue: { threshold: 9 } } }).success).toBe(true);
    expect(storedCorrelationConfigSchema.safeParse({ rules: { mfa_fatigue: { threshold: 0 } } }).success).toBe(false);
  });
  it("loads enough history for the longest enabled window, bounded", () => {
    expect(lookbackMinutes(DEFAULT_CORRELATION_CONFIG)).toBe(120);
    expect(lookbackMinutes(withRule("brute_force_account", { windowMinutes: 1440 }))).toBe(2880);
  });
});
