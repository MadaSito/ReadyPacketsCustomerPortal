/**
 * Idle-timeout warning for full sessions. The server enforces idle and absolute expiry; this only warns
 * before the server-side idle limit and signs out locally when it passes. Activity = pointer, key, scroll, touch.
 */
import { useEffect, useRef, useState } from "react";
import { useSignOut } from "@/lib/signOut";
import { useRefreshSession, useSession } from "@/lib/session";
import { Button, Dialog, useToast } from "@/ui";

/** Fallback only, used when identity.me does not (yet) report the server idle policy. */
export const IDLE_DEFAULTS = { idleMs: 30 * 60_000, warnBeforeMs: 2 * 60_000 } as const;

/** Idle limit from the server policy (identity.me → session.idleTimeoutSeconds), else the fallback. */
export function idleLimitMs(idleTimeoutSeconds: number | undefined): number {
  return typeof idleTimeoutSeconds === "number" && Number.isFinite(idleTimeoutSeconds) && idleTimeoutSeconds >= 60 ? idleTimeoutSeconds * 1000 : IDLE_DEFAULTS.idleMs;
}

/** Warn 2 minutes before, or at half the limit for very short policies. */
export function warnBeforeFor(idleMs: number): number {
  return Math.min(IDLE_DEFAULTS.warnBeforeMs, Math.floor(idleMs / 2));
}

/** ms until the absolute-expiry warning should show (null = no valid expiry or already past). */
export function absoluteWarningDelay(absoluteExpiresAt: string | undefined, now: number, warnBeforeMs = IDLE_DEFAULTS.warnBeforeMs): number | null {
  const at = absoluteExpiresAt ? Date.parse(absoluteExpiresAt) : NaN;
  if (!Number.isFinite(at) || at <= now) return null;
  return Math.max(0, at - warnBeforeMs - now);
}

/**
 * Reads the server policy (identity.me → session) and renders the idle warning with it. The server's own
 * idle clock is refreshed by background requests, so this input-idle timer is the human-inactivity signal.
 * Also warns once before the non-extendable absolute expiry and re-checks the session when it passes.
 */
export function SessionIdleTimeout() {
  const { me } = useSession();
  const toast = useToast();
  const refresh = useRefreshSession();
  const idleMs = idleLimitMs(me?.session?.idleTimeoutSeconds);
  const absoluteExpiresAt = me?.session?.absoluteExpiresAt;

  useEffect(() => {
    const delay = absoluteWarningDelay(absoluteExpiresAt, Date.now());
    if (delay === null) return;
    const warn = window.setTimeout(
      () => toast.show({ tone: "warning", title: "Your session ends soon", description: "For security, sessions have a maximum length. Save your work; you'll need to sign in again shortly.", duration: 0 }),
      delay,
    );
    const end = window.setTimeout(() => void refresh(), Math.max(0, Date.parse(absoluteExpiresAt!) - Date.now()) + 1000);
    return () => {
      window.clearTimeout(warn);
      window.clearTimeout(end);
    };
  }, [absoluteExpiresAt, toast, refresh]);

  return <IdleTimeout idleMs={idleMs} warnBeforeMs={warnBeforeFor(idleMs)} />;
}

export function IdleTimeout({ idleMs = IDLE_DEFAULTS.idleMs, warnBeforeMs = IDLE_DEFAULTS.warnBeforeMs }: { idleMs?: number; warnBeforeMs?: number }) {
  const [warning, setWarning] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const lastActivity = useRef(0);
  const signOut = useSignOut();
  const refresh = useRefreshSession();
  const warningRef = useRef(false);

  useEffect(() => {
    warningRef.current = warning;
  }, [warning]);

  useEffect(() => {
    lastActivity.current = Date.now();
    const onActivity = () => {
      if (!warningRef.current) lastActivity.current = Date.now();
    };
    const events = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    const timer = window.setInterval(() => {
      const idle = Date.now() - lastActivity.current;
      if (idle >= idleMs) {
        window.clearInterval(timer);
        void signOut();
      } else if (idle >= idleMs - warnBeforeMs) {
        setWarning(true);
        setRemaining(Math.ceil((idleMs - idle) / 1000));
      }
    }, 1000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity));
      window.clearInterval(timer);
    };
  }, [idleMs, warnBeforeMs, signOut]);

  const stay = async () => {
    lastActivity.current = Date.now();
    setWarning(false);
    await refresh();
  };
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return (
    <Dialog
      open={warning}
      onOpenChange={(open) => !open && void stay()}
      title="Are you still there?"
      description="For your security, you will be signed out soon because of inactivity."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out now
          </Button>
          <Button onClick={() => void stay()}>Stay signed in</Button>
        </>
      }
    >
      <p className="text-sm text-ink" aria-live="off">
        Time remaining: <strong className="tabular-nums">{minutes}:{String(seconds).padStart(2, "0")}</strong>
      </p>
    </Dialog>
  );
}
