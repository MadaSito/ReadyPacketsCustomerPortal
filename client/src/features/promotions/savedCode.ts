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
/** Chosen codes are 6–32 characters; batch codes may carry a prefix plus at least 12 characters. */
const CODE_PATTERN = /^[A-Z0-9](?:[A-Z0-9-]{4,46})[A-Z0-9]$/u;

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
