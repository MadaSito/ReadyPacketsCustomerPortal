/**
 * Cookie-consent store (increment 04, package J). Owner: platform_engineer (new file in @/lib by agreement
 * with ui_foundation_engineer).
 *
 * The single client authority for "may this optional tool run?". Nothing optional runs until a choice is
 * made: `has()` is false for every optional category until the feature is on AND a choice exists for the
 * current policy version that is younger than the renewal period. Global Privacy Control / Do Not Track
 * count as "reject" until the person chooses otherwise.
 *
 * The choice itself is stored in first-party localStorage (`rp.consent.v1`) because storing the choice is
 * strictly necessary; it holds no personal data (random id, flags, version, time). The preview build keeps
 * it in memory. The server ledger (platform.consent.record) is the proof; this copy is only the cache.
 */
import { useSyncExternalStore } from "react";
import { RUNTIME } from "./runtime";

export type ConsentCategory = "necessary" | "preferences" | "analytics" | "session_replay";
export type OptionalCategory = Exclude<ConsentCategory, "necessary">;
export const OPTIONAL_CATEGORIES: readonly OptionalCategory[] = ["preferences", "analytics", "session_replay"];

export interface ConsentChoices {
  preferences: boolean;
  analytics: boolean;
  session_replay: boolean;
}

export interface ConsentConfig {
  enabled: boolean;
  policyVersion: number | null;
  renewMonths: number;
}

export interface ConsentState {
  enabled: boolean;
  /** A valid choice exists for the current policy version and renewal period. */
  decided: boolean;
  choices: ConsentChoices;
  policyVersion: number | null;
  decidedAt: string | null;
  /** Browser signals Global Privacy Control or Do Not Track. */
  gpc: boolean;
  /** Random anonymous id that links this browser's decisions in the ledger (null until the server issued one). */
  consentId: string | null;
  /** The stored choice was made by the GPC / DNT signal, not by the person. */
  bySignal: boolean;
}

interface StoredChoice {
  v: 1;
  /** Server-signed `<consentId>.<signature>`; null until the server recorded a decision. */
  receipt: string | null;
  policyVersion: number;
  choices: ConsentChoices;
  decidedAt: string;
  bySignal: boolean;
}

export const CONSENT_STORAGE_KEY = "rp.consent.v1";
const NONE: ConsentChoices = Object.freeze({ preferences: false, analytics: false, session_replay: false });
const RECEIPT = /^[A-Za-z0-9_-]{22}\.[0-9a-f]{32}$/;

let config: ConsentConfig = { enabled: false, policyVersion: null, renewMonths: 12 };
let memoryChoice: StoredChoice | null = null;
let loaded = false;
let snapshotCache: ConsentState | null = null;
let now: () => number = () => Date.now();
const listeners = new Set<(state: ConsentState) => void>();
const openListeners = new Set<() => void>();

function storageAvailable(): Storage | null {
  if (RUNTIME.preview || typeof window === "undefined") return null;
  try {
    // eslint-disable-next-line no-restricted-properties -- stores only the cookie choice (random id, flags, policy version, time): strictly necessary to honour it; no session material. Approved by /root.
    return window.localStorage;
  } catch {
    return null;
  }
}

function parseStored(raw: string | null): StoredChoice | null {
  if (!raw || raw.length > 1024) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredChoice> & { choices?: Partial<ConsentChoices> };
    if (value.v !== 1) return null;
    const receipt = typeof value.receipt === "string" && RECEIPT.test(value.receipt) ? value.receipt : null;
    if (typeof value.policyVersion !== "number" || !Number.isInteger(value.policyVersion) || value.policyVersion < 1) return null;
    if (typeof value.decidedAt !== "string" || Number.isNaN(Date.parse(value.decidedAt))) return null;
    const c: Partial<ConsentChoices> = value.choices ?? {};
    return {
      v: 1,
      receipt,
      policyVersion: value.policyVersion,
      decidedAt: value.decidedAt,
      bySignal: value.bySignal === true,
      choices: { preferences: c.preferences === true, analytics: c.analytics === true, session_replay: c.session_replay === true },
    };
  } catch {
    return null;
  }
}

function readChoice(): StoredChoice | null {
  if (!loaded) {
    loaded = true;
    const store = storageAvailable();
    if (store) {
      try {
        memoryChoice = parseStored(store.getItem(CONSENT_STORAGE_KEY));
      } catch {
        memoryChoice = null;
      }
    }
  }
  return memoryChoice;
}

let writeSeq = 0;

function writeChoice(choice: StoredChoice | null): void {
  writeSeq += 1;
  memoryChoice = choice;
  loaded = true;
  const store = storageAvailable();
  if (!store) return;
  try {
    if (choice) store.setItem(CONSENT_STORAGE_KEY, JSON.stringify(choice));
    else store.removeItem(CONSENT_STORAGE_KEY);
  } catch {
    // Storage full or blocked: the in-memory copy still applies for this page.
  }
}

/** Global Privacy Control or Do Not Track. */
export function browserSignalsOptOut(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
  return nav.globalPrivacyControl === true || nav.doNotTrack === "1" || nav.msDoNotTrack === "1";
}

const MONTH_MS = 30.4375 * 24 * 60 * 60 * 1000;

function compute(): ConsentState {
  const stored = readChoice();
  const gpc = browserSignalsOptOut();
  const fresh =
    stored !== null &&
    config.policyVersion !== null &&
    stored.policyVersion === config.policyVersion &&
    now() - Date.parse(stored.decidedAt) < config.renewMonths * MONTH_MS &&
    Date.parse(stored.decidedAt) <= now() + 5 * 60_000;
  const decided = config.enabled && fresh;
  return {
    enabled: config.enabled,
    decided,
    choices: decided && stored ? { ...stored.choices } : { ...NONE },
    policyVersion: config.policyVersion,
    decidedAt: decided && stored ? stored.decidedAt : null,
    gpc,
    consentId: stored?.receipt ? stored.receipt.slice(0, 22) : null,
    bySignal: decided && stored ? stored.bySignal : false,
  };
}

/* --------------------------------------------------------------- vendor clean-up on withdrawal */

const VENDOR_COOKIES: Record<"analytics" | "session_replay", RegExp> = {
  analytics: /^(ph_|__ph_|posthog)/i,
  session_replay: /^(_clck|_clsk|CLID|ANONCHK|MR|MUID|SM|_cl)/,
};

function expireCookie(name: string): void {
  const host = window.location.hostname;
  const parts = host.split(".");
  const domains = [""];
  for (let i = 0; i < parts.length - 1; i += 1) domains.push(`; domain=.${parts.slice(i).join(".")}`);
  for (const domain of domains) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain}`;
}

/** Removes the cookies and storage entries of a withdrawn category that this origin can reach. */
export function removeVendorData(category: "analytics" | "session_replay"): void {
  if (typeof document === "undefined") return;
  const pattern = VENDOR_COOKIES[category];
  for (const pair of document.cookie ? document.cookie.split(";") : []) {
    const name = pair.split("=")[0]?.trim();
    if (name && pattern.test(name)) expireCookie(name);
  }
  for (const store of [storageAvailable(), RUNTIME.preview ? null : safeSession()]) {
    if (!store) continue;
    try {
      for (const key of Object.keys(store)) if (pattern.test(key)) store.removeItem(key);
    } catch {
      // ignore
    }
  }
}

function safeSession(): Storage | null {
  try {
    // eslint-disable-next-line no-restricted-properties -- sessionStorage is only read to REMOVE withdrawn vendor keys; nothing is written. Approved by /root.
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function emit(previous: ConsentState): void {
  snapshotCache = null;
  const next = snapshot();
  for (const category of ["analytics", "session_replay"] as const) {
    if (previous.choices[category] && !next.choices[category]) removeVendorData(category);
  }
  scheduleExpiry();
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  for (const listener of listeners) {
    try {
      listener(next);
    } catch {
      // A failing subscriber never blocks the others.
    }
  }
}

/** Moment the current choice stops being valid (renewal period), or null. */
function expiresAt(): number | null {
  const stored = readChoice();
  if (!stored || !config.enabled) return null;
  return Date.parse(stored.decidedAt) + config.renewMonths * MONTH_MS;
}

function snapshot(): ConsentState {
  // Long-lived tabs: a cached "decided" state must not outlive the renewal period.
  if (snapshotCache?.decided) {
    const end = expiresAt();
    if (end !== null && now() >= end) {
      const stale = snapshotCache;
      snapshotCache = compute();
      // Tell subscribers (and clean vendor data) about the true -> false transition, once.
      queueMicrotask(() => emit(stale));
      return snapshotCache;
    }
  }
  snapshotCache ??= compute();
  return snapshotCache;
}

/** Re-reads the stored choice (another tab may have changed it) and notifies subscribers of any change. */
function refresh(): void {
  // The raw published state (possibly expired), so a grant -> denial transition is never missed.
  const previous = snapshotCache ?? snapshot();
  loaded = false;
  emit(previous);
}

let expiryTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleExpiry(): void {
  if (typeof window === "undefined") return;
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  const end = expiresAt();
  if (end === null || end <= now()) return;
  // Browsers cap timers at about 24.8 days; re-arm in steps.
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    refresh();
  }, Math.min(Math.max(end - now(), 0) + 50, 2 ** 31 - 1));
}

let watching = false;
function onStorage(event: StorageEvent): void {
  if (event.key === CONSENT_STORAGE_KEY || event.key === null) refresh();
}
function onWake(): void {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") refresh();
}
/** Cross-tab and wake-up handling: withdrawal in one tab stops tools in every tab. */
function watch(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", onWake);
  window.addEventListener("pageshow", onWake);
  document.addEventListener("visibilitychange", onWake);
}
function unwatch(): void {
  if (!watching || typeof window === "undefined") return;
  watching = false;
  window.removeEventListener("storage", onStorage);
  window.removeEventListener("focus", onWake);
  window.removeEventListener("pageshow", onWake);
  document.removeEventListener("visibilitychange", onWake);
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
}

/* --------------------------------------------------------------- public port */

export const consent = {
  /** "necessary" is always true; optional categories only after an explicit, current choice. */
  has(category: ConsentCategory): boolean {
    if (category === "necessary") return true;
    const state = snapshot();
    return state.decided && state.choices[category];
  },
  /** The consent feature is switched on by the administrator. */
  enabled(): boolean {
    return config.enabled;
  },
  snapshot,
  subscribe(listener: (state: ConsentState) => void): () => void {
    listeners.add(listener);
    watch();
    scheduleExpiry();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) unwatch();
    };
  },
  /** Opens the preference centre (footer link, account page). */
  openPreferences(): void {
    for (const listener of openListeners) listener();
  },
};

/* --------------------------------------------------------------- platform-internal (CookieConsent) */

/** Fed by the platform consent component from the public bootstrap. */
export function configureConsent(next: ConsentConfig): void {
  const previous = snapshot();
  config = { enabled: next.enabled, policyVersion: next.policyVersion, renewMonths: Math.min(13, Math.max(6, next.renewMonths)) };
  emit(previous);
}

/**
 * Stores a decision locally. Denials (reject, withdraw, GPC default) are applied BEFORE the ledger call so
 * a failed request can never leave a tool running; grants are applied after the server recorded them.
 */
export function applyConsentDecision(choices: ConsentChoices, meta: { policyVersion: number; receipt?: string | null; decidedAt?: string; bySignal?: boolean }): void {
  const previous = snapshot();
  const receipt = meta.receipt && RECEIPT.test(meta.receipt) ? meta.receipt : (readChoice()?.receipt ?? null);
  writeChoice({
    v: 1,
    receipt,
    policyVersion: meta.policyVersion,
    choices: { preferences: choices.preferences, analytics: choices.analytics, session_replay: choices.session_replay },
    decidedAt: meta.decidedAt ?? new Date(now()).toISOString(),
    bySignal: meta.bySignal === true,
  });
  emit(previous);
}

/**
 * Store-wide revision of the persisted decision: this tab's write counter plus the raw value currently in
 * storage (read fresh, so another tab's write counts even before its storage event arrives).
 */
export function consentRevision(): string {
  const store = storageAvailable();
  let raw = "";
  if (store) {
    try {
      raw = store.getItem(CONSENT_STORAGE_KEY) ?? "";
    } catch {
      raw = "";
    }
  }
  return `${writeSeq}|${raw}|${config.policyVersion ?? ""}|${browserSignalsOptOut() ? 1 : 0}`;
}

/**
 * Applies a server-confirmed decision only if nothing changed since `revision` was taken (another decision in
 * this or another tab, a policy change or a privacy-signal change). Returns false when the response is stale;
 * the newer state then stands. Synchronous, so the check and the write cannot interleave in this tab.
 */
export function commitConsentDecision(revision: string, choices: ConsentChoices, meta: { policyVersion: number; receipt?: string | null; bySignal?: boolean }): boolean {
  if (consentRevision() !== revision || config.policyVersion !== meta.policyVersion) {
    refresh();
    return false;
  }
  applyConsentDecision(choices, meta);
  return true;
}

/** Stores the receipt the server returned without changing the decision. */
export function attachConsentReceipt(receipt: string): void {
  const stored = readChoice();
  if (!stored || !RECEIPT.test(receipt)) return;
  const previous = snapshot();
  writeChoice({ ...stored, receipt });
  emit(previous);
}

/** The receipt of this browser's previous decision, sent back so the ledger can group them. */
export function consentReceipt(): string | undefined {
  return readChoice()?.receipt ?? undefined;
}

/**
 * The part of a requested choice that may be applied before the ledger call: current AND requested, so
 * only removals take effect early and nothing new is granted until the server recorded the decision.
 * Returns null when the request removes nothing.
 */
export function removalsOnly(requested: ConsentChoices): ConsentChoices | null {
  const current = snapshot().choices;
  const removes = OPTIONAL_CATEGORIES.some((c) => current[c] && !requested[c]);
  if (!removes) return null;
  return {
    preferences: current.preferences && requested.preferences,
    analytics: current.analytics && requested.analytics,
    session_replay: current.session_replay && requested.session_replay,
  };
}

export function onOpenPreferences(listener: () => void): () => void {
  openListeners.add(listener);
  return () => openListeners.delete(listener);
}

/* --------------------------------------------------------------- React */

const subscribeReact = (cb: () => void) => consent.subscribe(() => cb());

export function useConsent(): ConsentState & { has: (category: ConsentCategory) => boolean; openPreferences: () => void } {
  const state = useSyncExternalStore(subscribeReact, snapshot, snapshot);
  return { ...state, has: consent.has, openPreferences: consent.openPreferences };
}

/* --------------------------------------------------------------- tests */

/** Test helper: sets config + choice directly (no storage). Pass `null` choices to clear. */
export function __setConsentForTests(state: { enabled?: boolean; policyVersion?: number; renewMonths?: number; choices?: Partial<ConsentChoices> | null; decidedAt?: string; bySignal?: boolean; clock?: () => number }): void {
  const previous = snapshot();
  if (state.clock) now = state.clock;
  config = {
    enabled: state.enabled ?? config.enabled,
    policyVersion: state.policyVersion ?? config.policyVersion ?? 1,
    renewMonths: state.renewMonths ?? config.renewMonths,
  };
  loaded = true;
  memoryChoice =
    state.choices === null
      ? null
      : state.choices
        ? {
            v: 1,
            receipt: memoryChoice?.receipt ?? null,
            policyVersion: config.policyVersion ?? 1,
            choices: { ...NONE, ...state.choices },
            decidedAt: state.decidedAt ?? new Date(now()).toISOString(),
            bySignal: state.bySignal === true,
          }
        : memoryChoice;
  emit(previous);
}

/** Test helper: back to the initial state (feature off, no choice, real clock). */
export function __resetConsentForTests(): void {
  config = { enabled: false, policyVersion: null, renewMonths: 12 };
  memoryChoice = null;
  loaded = false;
  writeSeq = 0;
  now = () => Date.now();
  snapshotCache = null;
  unwatch();
  listeners.clear();
  openListeners.clear();
  const store = storageAvailable();
  try {
    store?.removeItem(CONSENT_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Test helper: the storage the store uses (to simulate another tab or tampering). */
export function __storageForTests(): Storage {
  const store = storageAvailable();
  if (!store) throw new Error("storage unavailable");
  return store;
}
