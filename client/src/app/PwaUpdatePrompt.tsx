/**
 * Service-worker registration + "update available" prompt (no virtual modules, so the shell builds with or
 * without vite-plugin-pwa). The SW precaches the static shell only; /api and authenticated content are
 * NetworkOnly (config: docs in features/dashboard/VERIFICATION.md). Not registered in dev or the preview build.
 * Update flow: new worker installs → waits → user chooses Reload → SKIP_WAITING → controllerchange → reload.
 */
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { RUNTIME } from "@/lib/runtime";
import { Button } from "@/ui";

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
  return (
    <div role="status" className="fixed inset-x-3 bottom-20 z-[55] mx-auto flex max-w-md flex-col gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-4 text-ink shadow-[var(--shadow-raised)] sm:right-5 sm:bottom-5 sm:left-auto sm:mx-0 sm:flex-row sm:items-center md:bottom-5 rp-forced-border">
      <p className="flex-1 text-sm">
        <span className="font-semibold">A new version of ReadyPackets is available.</span> Reload to update; unsaved form input on this page will be lost.
      </p>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" variant="secondary" onClick={() => setWaiting(null)}>
          Later
        </Button>
        <Button size="sm" leadingIcon={<RefreshCw aria-hidden="true" />} onClick={() => waiting.postMessage({ type: "SKIP_WAITING" })}>
          Reload
        </Button>
      </div>
    </div>
  );
}
