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
  /** ms; default 5000 (danger: 8000); with an action at least 10000. 0 = stays until dismissed. */
  duration?: number;
  /** Optional inline action (e.g. Undo). A real button inside the live region; dismisses the toast on click. */
  action?: ToastAction;
}
export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}
/** Minimum auto-dismiss time while a toast carries an action (WCAG 2.2.1: enough time to reach it). */
export const TOAST_ACTION_MIN_DURATION = 10_000;
interface ToastItem extends Required<Omit<ToastInput, "description" | "action">> {
  id: number;
  description?: string;
  action?: ToastAction;
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
    holds.current.delete(id);
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
      const base = input.duration ?? (tone === "danger" ? 8000 : 5000);
      const duration = input.action && base > 0 ? Math.max(base, TOAST_ACTION_MIN_DURATION) : base;
      setItems((list) => [...list.slice(-4), { id, title: input.title, description: input.description, tone, duration, action: input.action }]);
      schedule(id, duration);
      return id;
    },
    [schedule],
  );

  /** Pause auto-dismiss while the toast is hovered OR focused (WCAG 2.2.1); resume only when neither holds. */
  const holds = useRef(new Map<number, { hover: boolean; focus: boolean }>());
  const hold = useCallback(
    (t: ToastItem, kind: "hover" | "focus", on: boolean) => {
      const state = { hover: false, focus: false, ...holds.current.get(t.id) };
      state[kind] = on;
      holds.current.set(t.id, state);
      clearTimeout(timers.current.get(t.id));
      timers.current.delete(t.id);
      if (!state.hover && !state.focus) {
        holds.current.delete(t.id);
        schedule(t.id, t.duration);
      }
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
          onMouseEnter={() => hold(t, "hover", true)}
          onMouseLeave={() => hold(t, "hover", false)}
          onFocus={() => hold(t, "focus", true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hold(t, "focus", false);
          }}
          className="pointer-events-auto flex w-full overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface text-ink shadow-[var(--shadow-raised)] motion-safe:animate-fade-in rp-forced-border"
        >
          <span aria-hidden="true" className={cn("w-1.5 shrink-0", toneBar[t.tone])} />
          <div className="min-w-0 flex-1 py-3 pl-3">
            <p className="text-sm font-semibold">
              <span className="sr-only">{toneLabel[t.tone]}: </span>
              {t.title}
            </p>
            {t.description ? <p className="mt-0.5 text-sm text-body">{t.description}</p> : null}
            {t.action ? (
              <button
                type="button"
                data-testid="toast-action"
                onClick={() => {
                  const action = t.action;
                  dismiss(t.id);
                  void action?.onClick();
                }}
                className="mt-2 inline-flex min-h-8 min-w-11 items-center justify-center rounded-[var(--radius-control)] border border-line px-3 text-sm font-semibold text-action underline-offset-2 hover:bg-surface-sunken hover:underline rp-forced-border"
              >
                {t.action.label}
              </button>
            ) : null}
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
