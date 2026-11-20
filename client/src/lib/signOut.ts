/** Sign-out: server revocation, then wipe all client query data and the static-shell caches. */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useLocation } from "wouter";
import { useAuthApi } from "./authApi";
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

export function useSignOut(): () => Promise<void> {
  const api = useAuthApi();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  return useCallback(async () => {
    try {
      await api.signOut();
    } finally {
      queryClient.clear();
      await clearClientCaches();
      navigate("/sign-in", { replace: true });
    }
  }, [api, queryClient, navigate]);
}
