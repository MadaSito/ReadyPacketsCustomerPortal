import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONSENT_STORAGE_KEY,
  __resetConsentForTests,
  __setConsentForTests,
  applyConsentDecision,
  attachConsentReceipt,
  configureConsent,
  consent,
  consentReceipt,
  removalsOnly,
} from "./consent";

const RECEIPT = `${"A".repeat(22)}.${"0".repeat(32)}`;
const ALL = { preferences: true, analytics: true, session_replay: true };
const NONE = { preferences: false, analytics: false, session_replay: false };
const MONTH = 30.4375 * 24 * 60 * 60 * 1000;

let t = Date.parse("2026-11-01T00:00:00Z");
const clock = () => t;

beforeEach(() => {
  __resetConsentForTests();
  t = Date.parse("2026-11-01T00:00:00Z");
  document.cookie.split(";").forEach((c) => {
    const n = c.split("=")[0]?.trim();
    if (n) document.cookie = `${n}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });
});
afterEach(() => {
  vi.useRealTimers();
  __resetConsentForTests();
});

describe("consent store", () => {
  it("is false for every optional category before a decision, and while the feature is off", () => {
    expect(consent.has("necessary")).toBe(true);
    expect(consent.has("analytics")).toBe(false);
    __setConsentForTests({ enabled: false, choices: ALL, clock });
    expect(consent.has("analytics")).toBe(false);
    expect(consent.has("session_replay")).toBe(false);
    __setConsentForTests({ enabled: true, choices: null });
    expect(consent.has("analytics")).toBe(false);
  });

  it("grants only after an explicit current choice", () => {
    __setConsentForTests({ enabled: true, policyVersion: 1, choices: { analytics: true }, clock });
    expect(consent.has("analytics")).toBe(true);
    expect(consent.has("session_replay")).toBe(false);
  });

  it("re-asks after a policy version change", () => {
    __setConsentForTests({ enabled: true, policyVersion: 1, choices: ALL, clock });
    configureConsent({ enabled: true, policyVersion: 2, renewMonths: 12 });
    expect(consent.snapshot().decided).toBe(false);
    expect(consent.has("analytics")).toBe(false);
  });

  it("expires a cached grant in a long-lived tab and notifies subscribers once with vendor clean-up", async () => {
    __setConsentForTests({ enabled: true, policyVersion: 1, renewMonths: 6, choices: ALL, clock });
    const seen: boolean[] = [];
    const off = consent.subscribe((s) => seen.push(s.choices.analytics));
    document.cookie = "_clck=x; path=/";
    document.cookie = "ph_test=y; path=/";
    expect(consent.has("session_replay")).toBe(true);
    t += 6 * MONTH + 1;
    expect(consent.has("session_replay")).toBe(false);
    await Promise.resolve();
    expect(seen).toEqual([false]);
    expect(document.cookie).not.toContain("_clck");
    expect(document.cookie).not.toContain("ph_test");
    // No further notifications once expired.
    expect(consent.has("analytics")).toBe(false);
    await Promise.resolve();
    expect(seen).toEqual([false]);
    off();
  });

  it("the expiry timer fires once and is not re-armed for a past deadline", () => {
    vi.useFakeTimers();
    __setConsentForTests({ enabled: true, policyVersion: 1, renewMonths: 6, choices: ALL, clock });
    const seen: boolean[] = [];
    const off = consent.subscribe((s) => seen.push(s.decided));
    t += 6 * MONTH + 1;
    vi.advanceTimersByTime(2 ** 31 - 1);
    vi.runOnlyPendingTimers();
    expect(seen).toEqual([false]);
    expect(vi.getTimerCount()).toBe(0);
    off();
  });

  it("follows a withdrawal made in another tab", () => {
    applyConsentDecision(ALL, { policyVersion: 1, receipt: RECEIPT });
    configureConsent({ enabled: true, policyVersion: 1, renewMonths: 12 });
    const seen: boolean[] = [];
    const off = consent.subscribe((s) => seen.push(s.choices.session_replay));
    expect(consent.has("session_replay")).toBe(true);
    const withdrawn = JSON.stringify({ v: 1, receipt: RECEIPT, policyVersion: 1, choices: NONE, decidedAt: new Date().toISOString(), bySignal: false });
    window.localStorage.setItem(CONSENT_STORAGE_KEY, withdrawn);
    window.dispatchEvent(new StorageEvent("storage", { key: CONSENT_STORAGE_KEY, newValue: withdrawn }));
    expect(consent.has("session_replay")).toBe(false);
    expect(seen).toEqual([false]);
    off();
  });

  it("removes reachable vendor cookies on withdrawal", () => {
    __setConsentForTests({ enabled: true, policyVersion: 1, choices: ALL, clock });
    document.cookie = "_clsk=1; path=/";
    document.cookie = "keep_me=1; path=/";
    applyConsentDecision(NONE, { policyVersion: 1 });
    expect(document.cookie).not.toContain("_clsk");
    expect(document.cookie).toContain("keep_me");
  });

  it("records a GPC default as a signal-made rejection", () => {
    configureConsent({ enabled: true, policyVersion: 1, renewMonths: 12 });
    applyConsentDecision(NONE, { policyVersion: 1, bySignal: true });
    const s = consent.snapshot();
    expect(s.decided).toBe(true);
    expect(s.bySignal).toBe(true);
    expect(consent.has("analytics")).toBe(false);
  });

  it("applies only removals before the ledger call for a mixed change", () => {
    __setConsentForTests({ enabled: true, policyVersion: 1, choices: { analytics: true }, clock });
    const requested = { preferences: false, analytics: false, session_replay: true };
    const early = removalsOnly(requested);
    expect(early).toEqual(NONE);
    applyConsentDecision(early!, { policyVersion: 1 });
    expect(consent.has("analytics")).toBe(false);
    expect(consent.has("session_replay")).toBe(false);
    expect(removalsOnly(ALL)).toBeNull();
  });

  it("keeps only well-formed server receipts", () => {
    configureConsent({ enabled: true, policyVersion: 1, renewMonths: 12 });
    applyConsentDecision(NONE, { policyVersion: 1, receipt: "forged" });
    expect(consentReceipt()).toBeUndefined();
    attachConsentReceipt(RECEIPT);
    expect(consentReceipt()).toBe(RECEIPT);
    expect(consent.snapshot().consentId).toBe("A".repeat(22));
  });

  it("ignores tampered storage", () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ v: 2, choices: ALL }));
    configureConsent({ enabled: true, policyVersion: 1, renewMonths: 12 });
    expect(consent.has("analytics")).toBe(false);
  });
});
