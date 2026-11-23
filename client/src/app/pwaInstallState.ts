import { RUNTIME } from "@/lib/runtime";

interface NativeInstallPrompt extends Event {
  prompt(): Promise<{ outcome: "accepted" | "dismissed" }>;
}
type ManualInstall = "ios" | "mac";
export type InstallOutcome = "accepted" | "dismissed" | "unavailable";
type Snapshot = { available: boolean; installed: boolean; manual: ManualInstall | null };

export function safariInstall(userAgent: string, platform: string, touchPoints: number): ManualInstall | null {
  if (!/\bSafari\//.test(userAgent) || /\b(?:CriOS|Chrome|Chromium|FxiOS|EdgiOS|Edg|OPiOS|OPR|SamsungBrowser)\//.test(userAgent)) return null;
  if (/\b(?:iPhone|iPad|iPod)\b/.test(userAgent) || platform === "MacIntel" && touchPoints > 1) return "ios";
  const version = /\bVersion\/(\d+)/.exec(userAgent)?.[1];
  return /\bMacintosh\b/.test(userAgent) && Number(version) >= 17 ? "mac" : null;
}

const disabled = typeof window === "undefined" || import.meta.env.DEV || RUNTIME.preview || !window.isSecureContext;
const preferenceKey = "rp:pwa-install-dismissed";
const listeners = new Set<() => void>();
const initial: Snapshot = { available: false, installed: false, manual: null };
let current = initial;
let native: NativeInstallPrompt | null = null;
let dismissed = false;
let installed = false;
let standalone: MediaQueryList | undefined;
let busy = false;

/** Device preference store. Not used in the preview profile, where browser storage is unavailable. */
function preferenceStorage(): Storage | null {
  if (RUNTIME.preview || typeof window === "undefined") return null;
  try {
    // eslint-disable-next-line no-restricted-properties -- approved device preference only, never session material.
    return window.localStorage;
  } catch {
    return null;
  }
}

function readDismissal(): boolean {
  try {
    return preferenceStorage()?.getItem(preferenceKey) === "1";
  } catch {
    return false;
  }
}

function publish() {
  const nav = navigator as Navigator & { standalone?: boolean };
  const isInstalled = installed || nav.standalone === true || standalone?.matches === true;
  const manual = safariInstall(nav.userAgent, nav.platform, nav.maxTouchPoints);
  const available = !isInstalled && !dismissed && (native !== null || manual !== null);
  if (available === current.available && isInstalled === current.installed && manual === current.manual) return;
  current = { available, installed: isInstalled, manual };
  for (const listener of listeners) listener();
}

export function dismissInstall() {
  dismissed = true;
  native = null;
  try {
    preferenceStorage()?.setItem(preferenceKey, "1");
  } catch {
    // Browsers that deny storage still remember dismissal for this page.
  }
  publish();
}

export function subscribeInstall(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const getInstall = () => current;
export const getInitialInstall = () => initial;

// Listen at module evaluation, before lazy pages and account menus mount.
if (!disabled) {
  dismissed = readDismissal();
  standalone = window.matchMedia?.("(display-mode: standalone)");
  standalone?.addEventListener?.("change", publish);
  window.addEventListener("beforeinstallprompt", (event) => {
    const candidate = event as NativeInstallPrompt;
    if (typeof candidate.prompt !== "function") return;
    event.preventDefault();
    if (!dismissed && !current.installed) native = candidate;
    publish();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    native = null;
    publish();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === preferenceKey || event.key === null) {
      dismissed = readDismissal();
      publish();
    }
  });
  publish();
}

export async function promptInstall(): Promise<InstallOutcome> {
  if (busy) return "dismissed";
  if (!current.available) return "unavailable";
  if (!native) return "unavailable";
  const event = native;
  native = null;
  busy = true;
  try {
    const result = await event.prompt();
    if (result.outcome === "dismissed") {
      dismissInstall();
      return "dismissed";
    }
    // Registry/browser confirmation is appinstalled; accepted alone need not mean install succeeded.
    return "accepted";
  } catch {
    return "unavailable";
  } finally {
    busy = false;
    publish();
  }
}
