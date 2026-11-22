/**
 * Records a cookie decision. Removals take effect locally BEFORE the ledger call (current ∩ requested) so a
 * failed request can never leave a tool running; anything newly allowed takes effect only after the server
 * recorded it. Owner: platform engineer (package J).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { applyConsentDecision, commitConsentDecision, consent, consentReceipt, consentRevision, removalsOnly, type ConsentChoices } from "@/lib/consent";
import { safeError, useTRPC } from "@/lib/trpc";

export type ConsentAction = "accept_all" | "reject_all" | "save" | "withdraw";
export type ConsentSource = "banner" | "preferences" | "account" | "gpc";

export const NO_CHOICES: ConsentChoices = { preferences: false, analytics: false, session_replay: false };
export const ALL_CHOICES: ConsentChoices = { preferences: true, analytics: true, session_replay: true };

export type DecisionResult = { ok: true } | { ok: false; policyChanged: boolean; superseded?: boolean; message: string };

export function useConsentDecision() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const record = useMutation(trpc.platform.consent.record.mutationOptions());
  const [pending, setPending] = useState(false);

  const decide = useCallback(
    async (choices: ConsentChoices, action: ConsentAction, source: ConsentSource): Promise<DecisionResult> => {
      const state = consent.snapshot();
      const policyVersion = state.policyVersion;
      if (policyVersion === null) return { ok: false, policyChanged: false, message: "Cookie settings are not available right now." };
      const bySignal = source === "gpc";
      const allOff = !choices.preferences && !choices.analytics && !choices.session_replay;
      const early = removalsOnly(choices) ?? (allOff ? NO_CHOICES : null);
      if (early) applyConsentDecision(early, { policyVersion, bySignal });
      // Taken after the early removals: any later decision (any tab, any hook instance), policy change or
      // privacy-signal change makes this response stale, and a stale grant is never applied.
      const revision = consentRevision();
      setPending(true);
      try {
        const result = await record.mutateAsync({ receipt: consentReceipt(), policyVersion, choices, action, source, gpc: state.gpc });
        const committed = commitConsentDecision(revision, choices, { policyVersion: result.policyVersion, receipt: result.receipt, bySignal });
        await client.invalidateQueries({ queryKey: trpc.platform.consent.mine.queryKey() });
        if (!committed) return { ok: false, policyChanged: false, superseded: true, message: "A newer cookie choice was made meanwhile, so that one applies." };
        return { ok: true };
      } catch (error) {
        const safe = safeError(error);
        const policyChanged = safe?.reasonCode === "CONSENT_POLICY_CHANGED";
        if (policyChanged) await client.invalidateQueries({ queryKey: trpc.platform.bootstrap.queryKey() });
        return {
          ok: false,
          policyChanged,
          message: policyChanged
            ? "The cookie policy has changed. Please review it and choose again."
            : early
              ? "Your choice applies on this device, but it could not be recorded. Please try again later."
              : "Your choice could not be saved. Nothing optional was turned on. Please try again.",
        };
      } finally {
        setPending(false);
      }
    },
    [client, record, trpc],
  );

  return { decide, pending };
}
