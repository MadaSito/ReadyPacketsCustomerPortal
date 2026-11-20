/**
 * Idle-timeout warning for full sessions. The server enforces idle and absolute expiry; this only warns
 * before the server-side idle limit and signs out locally when it passes. Activity = pointer, key, scroll, touch.
 */
import { useEffect, useRef, useState } from "react";
import { useSignOut } from "@/lib/signOut";
import { useRefreshSession } from "@/lib/session";
import { Button, Dialog } from "@/ui";

export const IDLE_DEFAULTS = { idleMs: 30 * 60_000, warnBeforeMs: 2 * 60_000 } as const;

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
