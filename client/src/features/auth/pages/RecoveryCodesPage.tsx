import { useQuery } from "@tanstack/react-query";
import { useAuthApi } from "@/lib/authApi";
import { clearRecoveryBatch, stageRecoveryBatch, useRecoveryBatch } from "@/lib/recoveryBatch";
import { useSession } from "@/lib/session";
import { Callout, Skeleton } from "@/ui";
import { AuthLayout } from "../components/AuthLayout";
import { FactorForm } from "../components/FactorForm";
import { RecoveryCodesPanel } from "../components/RecoveryCodesPanel";
import { useContinueAfterAuth } from "../useAuthNavigation";

/**
 * Transition step acknowledge_recovery_codes. Shows a batch staged in memory (just issued); otherwise the
 * codes were lost before acknowledgment and the user proves a factor to receive a fresh batch.
 */
export default function RecoveryCodesPage() {
  const api = useAuthApi();
  const { me } = useSession();
  const proceed = useContinueAfterAuth();
  const batch = useRecoveryBatch();
  const state = useQuery({ queryKey: ["rp", "assurance", "state"], queryFn: () => api.assuranceState(), retry: false, enabled: !batch });

  if (batch) {
    return (
      <AuthLayout wide title="Save your recovery codes">
        <RecoveryCodesPanel
          batch={batch}
          onAcknowledge={async (recoverySetId) => {
            await api.acknowledgeRecoveryCodes({ recoverySetId });
            clearRecoveryBatch();
            await proceed(null, me?.user.role);
          }}
        />
      </AuthLayout>
    );
  }
  const methods = [...(state.data?.passkeyCount ? (["passkey"] as const) : []), ...(state.data?.totpEnrolled !== false ? (["totp"] as const) : [])];
  return (
    <AuthLayout title="Get new recovery codes" description="Your recovery codes were issued but not confirmed as saved. For your security, verify again to receive a fresh set; the unseen set stops working.">
      {state.isPending ? (
        <Skeleton lines={3} />
      ) : methods.length === 0 ? (
        <Callout tone="warning">No verification method is available. Contact ReadyPackets support to reset two-step verification.</Callout>
      ) : (
        <FactorForm
          methods={methods}
          submitLabel="Issue new codes"
          beginPasskey={() => api.beginPasskeyAuthentication({ purpose: "recovery_reissue" })}
          onSubmit={async (factor) => {
            const result = await api.recoverUnacknowledgedCodes({ factor });
            stageRecoveryBatch(result);
          }}
        />
      )}
    </AuthLayout>
  );
}
