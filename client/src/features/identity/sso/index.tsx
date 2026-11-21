/**
 * "Sign in with SSO" for the sign-in page (loaded by the app's SsoSignInSlot). Renders nothing unless single
 * sign-on is configured and enabled. A real link: the server starts the Entra flow with a 303.
 */
import { useQuery } from "@tanstack/react-query";
import { safeNextPath } from "@/app/guard";
import { useTRPC } from "@/lib/trpc";
import { SsoButton } from "@/ui";

export function ssoStartHref(next?: string | null): string {
  const safe = safeNextPath(next ?? null);
  return safe ? `/api/identity/sso/start?next=${encodeURIComponent(safe)}` : "/api/identity/sso/start";
}

export function SsoSignInButton({ next }: { next?: string }) {
  const trpc = useTRPC();
  const config = useQuery({ ...trpc.identity.sso.publicConfig.queryOptions(), staleTime: 60_000, retry: false });
  if (!config.data?.enabled) return null;
  return <SsoButton href={ssoStartHref(next)} label={config.data.buttonLabel} providerName={config.data.providerName} />;
}
