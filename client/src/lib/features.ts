/**
 * Public bootstrap + client feature switches (increment 04, package J). Owner: platform_engineer (new file in
 * @/lib by agreement with ui_foundation_engineer).
 *
 * One public query (`platform.bootstrap`) returns the on/off state of flags their owners marked
 * `clientVisible`, plus the consent configuration. Hiding navigation is UX only: every server procedure
 * still checks its own flag. Unknown / loading / failed ⇒ false (fail closed: hidden).
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { useTRPC } from "./trpc";

export interface Bootstrap {
  features: Record<string, boolean>;
  consent: { enabled: boolean; policyVersion: number; renewMonths: number };
}

export const BOOTSTRAP_STALE_MS = 60_000;

export function useBootstrap(): Bootstrap | undefined {
  const trpc = useTRPC();
  const query = useQuery({ ...trpc.platform.bootstrap.queryOptions(), staleTime: BOOTSTRAP_STALE_MS, retry: 1 });
  return query.data as Bootstrap | undefined;
}

function enabledIn(bootstrap: Bootstrap | undefined, flag: string): boolean {
  return bootstrap !== undefined && Object.hasOwn(bootstrap.features, flag) && bootstrap.features[flag] === true;
}

/** True only when the flag is clientVisible and on. */
export function useFeatureEnabled(flag: string): boolean {
  return enabledIn(useBootstrap(), flag);
}

/** One hook call for filtering many navigation entries. */
export function useFeatureFlags(): (flag: string) => boolean {
  const bootstrap = useBootstrap();
  return useCallback((flag: string) => enabledIn(bootstrap, flag), [bootstrap]);
}
