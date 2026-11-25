/**
 * Service-worker registration + "update available" prompt (no virtual modules, so the shell builds with or
 * without vite-plugin-pwa). The SW precaches the static shell only; /api and authenticated content are
 * network-only (worker: src/pwa/sw.ts). Not registered in dev or the preview build.
 * Update flow: new worker installs → waits → user chooses Reload → SKIP_WAITING → controllerchange → reload.
 *
 * 07.2: "Later" hides the prompt only on the current page. It comes back on the next in-app navigation, because a tab
 * left on the previous client keeps calling a server that was already updated (stale client code against a newer API).
 * The update is never applied automatically: a reload would drop in-memory state such as unsaved form input or
 * multi-step drafts, which can't be detected reliably across every feature.
 */
import { RefreshCw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useLocation } from "wouter";
import { RUNTIME } from "@/lib/runtime";
import { Button } from "@/ui";
import "./pwaInstallState";

export function shouldRegisterServiceWorker(env: { dev: boolean; preview: boolean; supported: boolean }): boolean {
  return env.supported && !env.dev && !env.preview;
}

export function PwaUpdatePrompt() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!shouldRegisterServiceWorker({ dev: import.meta.env.DEV, preview: RUNTIME.preview, supported: typeof navigator !== "undefined" && "serviceWorker" in navigator })) return;
    let cancelled = false;
    let reloading = false;
    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };
    const base = import.meta.env.BASE_URL;
    navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base })
      .then((reg) => {
        const track = (worker: ServiceWorker | null) => {
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller && !cancelled) setWaiting(worker);
          });
        };
        if (reg.waiting && navigator.serviceWorker.controller) setWaiting(reg.waiting);
        reg.addEventListener("updatefound", () => track(reg.installing));
      })
      .catch(() => {
        /* Registration failure only disables offline shell caching; the app works normally. */
      });
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  if (!waiting) return null;
  return <UpdateAvailablePrompt onReload={() => waiting.postMessage({ type: "SKIP_WAITING" })} />;
}

/**
 * The prompt itself (exported for tests). "Later" hides it until the next route change, then it is shown again.
 */
export function UpdateAvailablePrompt({ onReload }: { onReload: () => void }) {
  const [location] = useLocation();
  const [dismissed, setDismissed] = useState(false);
  const [seenLocation, setSeenLocation] = useState(location);
  const titleId = useId();
  if (seenLocation !== location) {
    // Derived-state reset during render (React's documented pattern): any route change re-shows the prompt.
    setSeenLocation(location);
    setDismissed(false);
  }
  if (dismissed) return null;
  return (
    <div
      role="status"
      aria-labelledby={titleId}
      data-testid="pwa-update-prompt"
      className="fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-[55] mx-auto flex max-w-md min-w-0 flex-col gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-4 text-ink shadow-[var(--shadow-raised)] rp-forced-border md:right-5 md:bottom-5 md:left-auto md:mx-0"
    >
      <div className="min-w-0 text-sm break-words">
        <p id={titleId} className="font-semibold">
          ReadyPackets was updated on the server
        </p>
        <p className="mt-1 text-muted">
          This tab is still running the previous version. Reload switches to the new version; you stay signed in, but unsaved input on this page is lost. Later keeps the previous version in this tab until you reload.
        </p>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="secondary" className="min-h-11" onClick={() => setDismissed(true)}>
          Later
        </Button>
        <Button size="sm" className="min-h-11" leadingIcon={<RefreshCw aria-hidden="true" />} onClick={onReload}>
          Reload
        </Button>
      </div>
    </div>
  );
}
