/**
 * Accessible countdown (increment 06). The visible remaining time is plain text in a <time> element and is
 * never a live region (no announcement every second). A separate polite status speaks once per milestone
 * crossed and once at the end; nothing is announced on mount. No animation, so reduced motion is unaffected.
 */
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "./cn";

export interface CountdownProps {
  /** Target instant (Date or ISO string). */
  to: Date | string;
  /** Names the countdown in announcements, e.g. "Maintenance starts". */
  label: string;
  /** Clock source (tests / server-corrected clocks). Defaults to Date.now. */
  now?: () => number;
  /** Seconds before the target at which the status announces (default 1 h, 15 min, 5 min, 1 min, 0). */
  milestones?: readonly number[];
  /** "off" when the caller already owns a controlled status message. */
  announce?: "milestones" | "off";
  onElapsed?: () => void;
  /** Visible and announced text once the target has passed (default "Now"). */
  elapsedText?: string;
  className?: string;
}

const DEFAULT_MILESTONES = [3600, 900, 300, 60, 0] as const;

/** Remaining whole seconds → coarse human text: days/hours/minutes far out, seconds only under 2 minutes. */
export function formatRemaining(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s >= 86400) {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    return h ? `${d} d ${h} h` : `${d} d`;
  }
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.ceil((s % 3600) / 60);
    return m === 60 ? `${h + 1} h` : m ? `${h} h ${m} min` : `${h} h`;
  }
  if (s >= 120) return `${Math.ceil(s / 60)} min`;
  if (s >= 60) return `1 min ${s - 60} s`;
  return `${s} s`;
}

export function Countdown({ to, label, now = Date.now, milestones = DEFAULT_MILESTONES, announce = "milestones", onElapsed, elapsedText = "Now", className }: CountdownProps) {
  const target = new Date(to).getTime();
  const valid = Number.isFinite(target);
  const [remaining, setRemaining] = useState(() => (valid ? (target - now()) / 1000 : 0));
  const [message, setMessage] = useState("");
  const crossed = useRef<Set<number> | null>(null);
  const elapsedFired = useRef(false);
  const onElapsedRef = useRef(onElapsed);
  useEffect(() => {
    onElapsedRef.current = onElapsed;
  }, [onElapsed]);
  const descId = useId();

  useEffect(() => {
    if (!valid) return;
    crossed.current = new Set(milestones.filter((m) => (target - now()) / 1000 <= m));
    elapsedFired.current = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const rem = (target - now()) / 1000;
      setRemaining(rem);
      const newly = milestones.filter((m) => rem <= m && !crossed.current!.has(m));
      if (newly.length) {
        for (const m of newly) crossed.current!.add(m);
        if (announce === "milestones") setMessage(rem <= 0 ? `${label}: ${elapsedText}` : `${label}: ${formatRemaining(rem)} remaining`);
      }
      if (rem <= 0) {
        if (!elapsedFired.current) {
          elapsedFired.current = true;
          onElapsedRef.current?.();
        }
        return;
      }
      // Wake at the next whole second of the remaining time.
      const frac = rem - Math.floor(rem);
      timer = setTimeout(tick, Math.max(50, Math.round((frac || 1) * 1000)));
    };
    tick();
    return () => clearTimeout(timer);
    // milestones is compared by content so inline arrays do not restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, valid, announce, label, elapsedText, milestones.join(",")]);

  if (!valid) return null;
  const absolute = new Date(target);
  const local = absolute.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <span className={cn("tabular-nums", className)}>
      <time dateTime={absolute.toISOString()} title={`${local} (${absolute.toISOString().replace(".000", "")})`} aria-describedby={descId}>
        {remaining <= 0 ? elapsedText : formatRemaining(remaining)}
      </time>
      <span id={descId} className="sr-only">
        {`${label} at ${local}`}
      </span>
      {announce === "milestones" ? (
        <span role="status" className="sr-only">
          {message}
        </span>
      ) : null}
    </span>
  );
}
