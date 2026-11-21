/**
 * /sso/complete?attempt=… — finishes a single sign-on attempt with a same-origin, CSRF-protected POST
 * (the provider callback only parked it). The attempt handle is opaque and single use.
 */
import { useEffect, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import type { TransitionStep } from "@shared/domain";
import { homeFor, safeNextPath, stepPath } from "@/app/guard";
import { useRefreshSession, useSession } from "@/lib/session";
import { sessionFetch } from "@/lib/sessionTransport";
import { useTRPCClient } from "@/lib/trpc";
import { Button, Callout, PageHeader, Spinner } from "@/ui";
import { ssoRefusal } from "./messages";

export interface SsoCompletion {
  purpose: "sign_in" | "link" | "step_up" | "test";
  next: string | null;
  nextStep?: TransitionStep | null;
  test?: Record<string, unknown>;
}

const ATTEMPT = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** One POST per attempt, even under StrictMode double effects (a second POST would burn nothing but fail). */
const inflight = new Map<string, Promise<SsoCompletion>>();

export function completeSsoAttempt(attempt: string): Promise<SsoCompletion> {
  let pending = inflight.get(attempt);
  if (!pending) {
    pending = sessionFetch("/api/identity/sso/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ attempt }),
    }).then(async (response) => {
      const body = (await response.json().catch(() => null)) as (SsoCompletion & { safe?: { reasonCode?: string } }) | null;
      if (!response.ok || !body?.purpose) throw new SsoCompletionError(body?.safe?.reasonCode ?? "SSO_FAILED");
      return body;
    });
    inflight.set(attempt, pending);
  }
  return pending;
}

export class SsoCompletionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SsoCompletionError";
  }
}

/** Test results are handed to the admin page in memory (never in the URL or browser storage). */
export const lastSsoTestResult: { value: Record<string, unknown> | null } = { value: null };

export default function SsoCompletePage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const refresh = useRefreshSession();
  const { me } = useSession();
  const client = useTRPCClient();
  const [failure, setError] = useState<string | null>(null);
  const attempt = new URLSearchParams(search).get("attempt") ?? "";
  const error = ATTEMPT.test(attempt) ? failure : "SSO_EXPIRED";

  useEffect(() => {
    if (!ATTEMPT.test(attempt)) return;
    let active = true;
    completeSsoAttempt(attempt).then(
      async (result) => {
        if (!active) return;
        await refresh();
        const next = safeNextPath(result.next);
        if (result.purpose === "sign_in") {
          if (result.nextStep) return navigate(stepPath(result.nextStep), { replace: true });
          const role = next ? undefined : (await client.identity.me.query().catch(() => null))?.user.role;
          navigate(next ?? homeFor(role ?? "customer"), { replace: true });
        } else if (result.purpose === "test") {
          lastSsoTestResult.value = result.test ?? null;
          navigate("/admin/sso?test=done", { replace: true });
        } else {
          navigate(next ?? "/account", { replace: true });
        }
      },
      (err: unknown) => {
        if (active) setError(err instanceof SsoCompletionError ? err.code : "SSO_FAILED");
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    const message = ssoRefusal(error);
    return (
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 py-10">
        <PageHeader title={message.title} />
        <Callout tone="danger" live="assertive">{message.body}</Callout>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button asChild><Link href="/sign-in">Back to sign-in</Link></Button>
          {me ? <Button asChild variant="secondary"><Link href="/account">Your account</Link></Button> : null}
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 py-10">
      <PageHeader title="Finishing single sign-on" description="Confirming your Microsoft sign-in with the portal." />
      <div className="flex items-center gap-3 text-muted">
        <Spinner label="Finishing sign-in" />
      </div>
    </div>
  );
}
