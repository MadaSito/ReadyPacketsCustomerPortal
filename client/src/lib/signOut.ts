/** Sign-out: server revocation, then wipe all client query data and the static-shell caches. */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useLocation } from "wouter";
import { useToast } from "@/ui/Toast";
import { ME_QUERY_KEY, useAuthApi } from "./authApi";
import { isUnauthenticated } from "./session";
import { clearRecoveryBatch } from "./recoveryBatch";

/** Deletes Cache Storage entries created by the service worker (static shell only, but cleared anyway). */
export async function clearClientCaches(): Promise<void> {
  clearRecoveryBatch();
  try {
    if (typeof caches === "undefined") return;
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  } catch {
    /* Cache Storage unavailable (sandboxed iframe / private mode) — nothing to clear */
  }
}

export class SignOutFailedError extends Error {
  constructor() {
    super("We couldn't sign you out. Check your connection and try again.");
    this.name = "SignOutFailedError";
  }
}

/**
 * Revokes the server session, then wipes client state. If revocation fails the HttpOnly cookie may still be
 * live, so we never pretend to be signed out: private data is wiped anyway (screens re-check identity.me before
 * rendering), identity is re-checked, and if the session is still valid the caller gets SignOutFailedError.
 */
export function useSignOut(): () => Promise<void> {
  const api = useAuthApi();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const toast = useToast();
  return useCallback(async () => {
    let revoked = true;
    try {
      await api.signOut();
    } catch (err) {
      revoked = isUnauthenticated(err);
    }
    queryClient.clear();
    await clearClientCaches();
    if (!revoked) {
      const stillSignedIn = await queryClient.fetchQuery({ queryKey: ME_QUERY_KEY, queryFn: () => api.me(), retry: false }).then(
        () => true,
        (err: unknown) => !isUnauthenticated(err),
      );
      if (stillSignedIn) {
        const error = new SignOutFailedError();
        toast.show({ tone: "danger", title: "Sign-out didn't complete", description: error.message });
        return;
      }
    }
    navigate("/sign-in", { replace: true });
  }, [api, queryClient, navigate, toast]);
}
