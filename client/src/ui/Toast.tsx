/**
 * Toasts announced through two persistent aria-live regions (polite for info/success, assertive for errors).
 * Non-modal, never steal focus; dismissible; auto-dismiss pauses on hover/focus.
 */
import { X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "./cn";

export type ToastTone = "info" | "success" | "warning" | "danger";
export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** ms; default 5000 (danger: 8000). 0 = stays until dismissed. */
  duration?: number;
}
interface ToastItem extends Required<Omit<ToastInput, "description">> {
  id: number;
  description?: string;
}
export interface ToastApi {
  show: (toast: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const noop: ToastApi = { show: () => 0, dismiss: () => {} };

export function useToast(): ToastApi {
  return useContext(ToastContext) ?? noop;
}

const toneBar: Record<ToastTone, string> = { info: "bg-info", success: "bg-success", warning: "bg-warning", danger: "bg-danger" };
const toneLabel: Record<ToastTone, string> = { info: "Information", success: "Success", warning: "Warning", danger: "Error" };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const schedule = useCallback(
    (id: number, duration: number) => {
      if (duration > 0) timers.current.set(id, setTimeout(() => dismiss(id), duration));
    },
    [dismiss],
  );

  const show = useCallback(
    (input: ToastInput) => {
      const id = ++seq.current;
      const tone = input.tone ?? "info";
      const duration = input.duration ?? (tone === "danger" ? 8000 : 5000);
      setItems((list) => [...list.slice(-4), { id, title: input.title, description: input.description, tone, duration }]);
      schedule(id, duration);
      return id;
    },
    [schedule],
  );

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  const render = (assertive: boolean) =>
    items
      .filter((t) => (t.tone === "danger") === assertive)
      .map((t) => (
        <div
          key={t.id}
          onMouseEnter={() => clearTimeout(timers.current.get(t.id))}
          onMouseLeave={() => schedule(t.id, t.duration)}
          onFocus={() => clearTimeout(timers.current.get(t.id))}
          className="pointer-events-auto flex w-full overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface text-ink shadow-[var(--shadow-raised)] motion-safe:animate-fade-in rp-forced-border"
        >
          <span aria-hidden="true" className={cn("w-1.5 shrink-0", toneBar[t.tone])} />
          <div className="min-w-0 flex-1 py-3 pl-3">
            <p className="text-sm font-semibold">
              <span className="sr-only">{toneLabel[t.tone]}: </span>
              {t.title}
            </p>
            {t.description ? <p className="mt-0.5 text-sm text-body">{t.description}</p> : null}
          </div>
          <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss notification" className="inline-flex size-11 shrink-0 items-center justify-center text-muted hover:text-ink">
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      ));

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:items-end sm:p-5">
        <div aria-live="polite" aria-atomic="false" role="status" className="flex w-full max-w-sm flex-col gap-2">
          {render(false)}
        </div>
        <div aria-live="assertive" aria-atomic="false" role="alert" className="flex w-full max-w-sm flex-col gap-2">
          {render(true)}
        </div>
      </div>
    </ToastContext.Provider>
  );
}
