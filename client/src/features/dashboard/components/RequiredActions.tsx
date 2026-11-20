/** Account-health prompts derived from the assurance state (server is the authority; this only guides). */
import { useQuery } from "@tanstack/react-query";
import { KeyRound, ShieldAlert } from "lucide-react";
import { Link } from "wouter";
import { useAuthApi, type AssuranceState } from "@/lib/authApi";
import { Button, Card } from "@/ui";

export interface RequiredAction {
  key: string;
  tone: "warning" | "info";
  title: string;
  body: string;
  href: string;
  cta: string;
}

export const LOW_RECOVERY_CODES = 3;

export function requiredActionsFor(state: AssuranceState | undefined): RequiredAction[] {
  if (!state) return [];
  const actions: RequiredAction[] = [];
  if (state.recoveryCodesRemaining <= LOW_RECOVERY_CODES) {
    actions.push({
      key: "recovery-low",
      tone: "warning",
      title: state.recoveryCodesRemaining === 0 ? "You have no recovery codes left" : `Only ${state.recoveryCodesRemaining} recovery code${state.recoveryCodesRemaining === 1 ? "" : "s"} left`,
      body: "Generate a new set so you can still sign in if you lose your authenticator.",
      href: "/account/security",
      cta: "Review security",
    });
  }
  if (state.passkeyCount === 0) {
    actions.push({ key: "passkey", tone: "info", title: "Add a passkey", body: "Sign in faster and resist phishing with your device's fingerprint, face or screen lock.", href: "/account/security", cta: "Add passkey" });
  }
  return actions;
}

export function RequiredActions() {
  const api = useAuthApi();
  const state = useQuery({ queryKey: ["rp", "assurance", "state"], queryFn: () => api.assuranceState(), retry: false });
  const actions = requiredActionsFor(state.data);
  if (actions.length === 0) return null;
  return (
    <section aria-labelledby="required-actions-heading" className="mb-6 sm:mb-8">
      <h2 id="required-actions-heading" className="mb-3 text-base font-semibold text-ink">
        Recommended for your account
      </h2>
      <ul className="grid gap-3 md:grid-cols-2">
        {actions.map((a) => {
          const Icon = a.tone === "warning" ? ShieldAlert : KeyRound;
          return (
            <li key={a.key}>
              <Card className="flex h-full flex-col gap-3 sm:flex-row sm:items-start">
                <span className={a.tone === "warning" ? "inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-warning-soft text-warning" : "inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-action-soft text-action"}>
                  <Icon className="size-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold text-ink">{a.title}</h3>
                  <p className="mt-1 text-sm text-body">{a.body}</p>
                </div>
                <Button asChild variant="secondary" size="sm" className="self-start">
                  <Link href={a.href}>{a.cta}</Link>
                </Button>
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
