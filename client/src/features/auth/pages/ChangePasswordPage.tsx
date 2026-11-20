import { useAuthApi } from "@/lib/authApi";
import { useSession } from "@/lib/session";
import { Callout } from "@/ui";
import { AuthLayout } from "../components/AuthLayout";
import { NewPasswordForm } from "../components/NewPasswordForm";
import { useContinueAfterAuth } from "../useAuthNavigation";

/** Forced password change (transition step change_password). Voluntary changes live in /account/security. */
export default function ChangePasswordPage() {
  const api = useAuthApi();
  const { me } = useSession();
  const proceed = useContinueAfterAuth();
  return (
    <AuthLayout title="Set a new password" description="Your administrator requires a new password before you continue.">
      <Callout tone="info" className="mb-5">
        Choose a password you haven't used here before. At least 15 characters; no other composition rules.
      </Callout>
      <NewPasswordForm
        withCurrent
        submitLabel="Save and continue"
        onSubmit={async ({ currentPassword, password }) => {
          const result = await api.changePassword({ currentPassword, newPassword: password });
          await proceed(result.nextStep, me?.user.role);
        }}
      />
    </AuthLayout>
  );
}
