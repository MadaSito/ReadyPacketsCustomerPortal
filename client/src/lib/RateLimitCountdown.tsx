import { useEffect, useState } from "react";
import { safeError } from "./trpc";

export function retryDelaySeconds(error: unknown): number | null {
  if (safeError(error)?.domainCode !== "RATE_LIMITED") return null;
  const { meta } = error as { meta?: { response?: Response } };
  const header = meta?.response?.headers.get("Retry-After");
  if (header && /^[0-9]{1,7}$/.test(header)) {
    const delay = Number(header);
    if (delay > 0 && delay <= 604_800) return delay;
  }
  return null;
}

/** Reads the authoritative header. Announcements happen at start/end, not every tick. Never resubmits. */
export function RateLimitCountdown({ error }: { error: unknown }) {
  const delay = retryDelaySeconds(error);
  const [timer, setTimer] = useState<{ error: unknown; remaining: number }>();
  useEffect(() => {
    if (delay === null) return;
    const deadline = Date.now() + delay * 1000;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setTimer({ error, remaining });
      if (remaining === 0) window.clearInterval(interval);
    };
    const interval = window.setInterval(tick, 1000);
    tick();
    return () => window.clearInterval(interval);
  }, [delay, error]);
  if (delay === null) return null;
  const remaining = timer && timer.error === error ? timer.remaining : delay;
  return <p className="text-sm tabular-nums">
    <span className="sr-only" role="status">{remaining === 0 ? "You can try again now." : "Too many requests. Wait before trying again."}</span>
    <span aria-hidden="true">{remaining === 0 ? "You can try again now." :
      `Try again in ${Math.floor(remaining / 60) > 0 ? `${Math.floor(remaining / 60)} min ` : ""}${remaining % 60} sec.`}</span>
  </p>;
}
