import { PolicyRemediationSlot } from "@/app/slots";
import { useSignOut } from "@/lib/signOut";
import { Button } from "@/ui";
import { AuthLayout } from "../components/AuthLayout";

/**
 * Transition step accept_policy (Increment 06 D13). The server holds the session in remediation until every
 * required policy version is accepted: the only actions here are reading/accepting (compliance forms, via an app
 * slot) or signing out. The compliance forms refresh the session after acceptance and the route guard moves on.
 */
export default function AcceptPolicyPage() {
  const signOut = useSignOut();
  return (
    <AuthLayout
      wide
      title="Review and accept updated policy"
      description="A policy that applies to your account has changed. Read it and accept it to continue, or sign out."
    >
      <PolicyRemediationSlot />
      <p className="mt-5 text-sm text-muted">
        If the policy does not load, sign out and sign in again. Contact support if the problem continues.
      </p>
      <Button variant="secondary" className="mt-4 w-full sm:w-auto" onClick={() => void signOut()}>
        Sign out
      </Button>
    </AuthLayout>
  );
}
