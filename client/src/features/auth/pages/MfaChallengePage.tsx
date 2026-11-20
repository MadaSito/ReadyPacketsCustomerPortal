import { useQuery } from "@tanstack/react-query";
import { useAuthApi } from "@/lib/authApi";
import { useSession } from "@/lib/session";
import { Button, Skeleton } from "@/ui";
import { useSignOut } from "@/lib/signOut";
import { AuthLayout } from "../components/AuthLayout";
import { FactorForm } from "../components/FactorForm";
import { useContinueAfterAuth } from "../useAuthNavigation";

export default function MfaChallengePage() {
  const api = useAuthApi();
  const { me } = useSession();
  const proceed = useContinueAfterAuth();
  const signOut = useSignOut();
  const state = useQuery({ queryKey: ["rp", "assurance", "state"], queryFn: () => api.assuranceState(), retry: false });
  const methods = [
    ...(state.data?.passkeyCount ? (["passkey"] as const) : []),
    ...(state.data?.totpEnrolled !== false ? (["totp"] as const) : []),
    "recovery_code" as const,
  ];
  return (
    <AuthLayout title="Two-step verification" description="Confirm it's you to finish signing in.">
      {state.isPending ? (
        <Skeleton lines={3} />
      ) : (
        <FactorForm
          methods={methods}
          submitLabel="Verify"
          beginPasskey={() => api.beginPasskeyAuthentication({ purpose: "challenge" })}
          onSubmit={async (factor) => {
            await api.challenge(factor);
            await proceed(null, me?.user.role);
          }}
        />
      )}
      <Button variant="link" className="mt-5" onClick={() => void signOut()}>
        Sign in with a different account
      </Button>
    </AuthLayout>
  );
}
