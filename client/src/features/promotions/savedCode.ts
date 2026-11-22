/**
 * Discount code carried by a promotion link (D3). Owner: audit engineer.
 *
 * A link is `/<path>#promo=<CODE>`: the code sits in the URL fragment, so it never reaches server access logs,
 * referrers or analytics (analytics also refuse any URL with a fragment). Opening the link stores the code in
 * sessionStorage for this browser tab only (never a cookie, never a query string) and immediately strips the
 * fragment with `history.replaceState`. The code is only OFFERED by PromoCodeField; nothing is applied silently.
 */
const KEY = "rp.promotions.savedCode";
const FRAGMENT_KEYS = ["promo", "code"] as const;
/**
 * Contract D3: codes are A–Z, 0–9 and hyphen, 6–32 characters (batch codes = optional prefix + ≥ 12 characters,
 * within the same 32). Deliberately no stricter than the server: the server decides, and answers uniformly.
 */
const CODE_PATTERN = /^[A-Z0-9-]{6,32}$/u;

export function normalizePromoCode(raw: string): string {
  return raw.normalize("NFKC").trim().replace(/\s+/gu, "").toUpperCase();
}

export function isPlausiblePromoCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

function storage(): Storage | null {
  try {
    // eslint-disable-next-line no-restricted-properties -- contract D3 (increment 05): a promotion link's code is kept for this tab only (sessionStorage, never a cookie); only the normalised code is stored and it is removed once applied or forgotten.
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readSavedPromoCode(): string | null {
  const value = storage()?.getItem(KEY) ?? null;
  return value && isPlausiblePromoCode(value) ? value : null;
}

export function savePromoCode(code: string): boolean {
  const normalized = normalizePromoCode(code);
  if (!isPlausiblePromoCode(normalized)) return false;
  try {
    storage()?.setItem(KEY, normalized);
    return storage() !== null;
  } catch {
    return false;
  }
}

export function clearSavedPromoCode(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* storage unavailable: nothing to clear */
  }
}

export type FragmentCapture = { kind: "saved"; code: string } | { kind: "invalid" } | { kind: "none" };

/**
 * Reads `#promo=` (or `#code=`) from the current URL, saves a plausible code and removes the WHOLE fragment
 * from the address bar before anything else can read it. Safe to call more than once.
 */
export function capturePromoCodeFromFragment(loc: Pick<Location, "hash" | "pathname" | "search"> = window.location, hist: Pick<History, "replaceState" | "state"> = window.history): FragmentCapture {
  const hash = loc.hash.startsWith("#") ? loc.hash.slice(1) : loc.hash;
  if (!hash) return { kind: "none" };
  const params = new URLSearchParams(hash);
  const raw = FRAGMENT_KEYS.map((k) => params.get(k)).find((v): v is string => typeof v === "string");
  try {
    hist.replaceState(hist.state, "", `${loc.pathname}${loc.search}`);
  } catch {
    /* history unavailable (tests / sandboxed frames) */
  }
  if (raw === undefined) return { kind: "none" };
  return savePromoCode(raw) ? { kind: "saved", code: normalizePromoCode(raw) } : { kind: "invalid" };
}

/** Builds the portal link an administrator copies (`/promo#promo=CODE`). */
export function promoLink(origin: string, code: string): string {
  return `${origin.replace(/\/+$/u, "")}/promo#promo=${encodeURIComponent(normalizePromoCode(code))}`;
}

/** Display mask for staff without reveal rights: first 2 and last 2 characters. */
export function maskPromoCode(code: string): string {
  if (code.length <= 4) return "•".repeat(code.length);
  return `${code.slice(0, 2)}${"•".repeat(Math.min(code.length - 4, 8))}${code.slice(-2)}`;
}

/** The only path whose fragment is read at startup. */
export const PROMO_LANDING_PATH = "/promo";

/**
 * Synchronous startup capture, called from the entry point BEFORE the router, providers or any analytics
 * module exist: on exactly `/promo` with a fragment, the code is saved and the fragment removed, so no later
 * reader (router, analytics, replay) ever sees it. Any other path is left untouched. Never throws.
 */
export function capturePromoLinkAtStartup(loc: Pick<Location, "hash" | "pathname" | "search"> = window.location, hist: Pick<History, "replaceState" | "state"> = window.history): FragmentCapture {
  try {
    if (loc.pathname !== PROMO_LANDING_PATH || !loc.hash) return { kind: "none" };
    const result = capturePromoCodeFromFragment(loc, hist);
    if (result.kind === "invalid") lastStartupCapture = "invalid";
    return result;
  } catch {
    return { kind: "none" };
  }
}

let lastStartupCapture: "invalid" | null = null;
/** Lets the landing page say "That link does not contain a valid code" after the startup capture ran. Read once. */
export function takeStartupInvalidCapture(): boolean {
  const invalid = lastStartupCapture === "invalid";
  lastStartupCapture = null;
  return invalid;
}
