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
    <AuthLayout title="Set a new password" description="The password you signed in with is temporary. Replace it with one of your own to continue.">
      <Callout tone="info" className="mb-5">
        First enter the temporary password you just signed in with, then choose your own. The new one needs at least 15 characters; there are no other composition rules.
      </Callout>
      <NewPasswordForm
        withCurrent
        currentLabel="Temporary password"
        currentHint="The password you just signed in with. If your browser filled in something else, replace it."
        currentIncorrectMessage="That is not the temporary password you signed in with. Enter it exactly as you received it; the new password goes in the field below."
        username={me?.user.email}
        submitLabel="Save and continue"
        onSubmit={async ({ currentPassword, password }) => {
          const result = await api.changePassword({ currentPassword, newPassword: password });
          await proceed(result.nextStep, me?.user.role);
        }}
      />
    </AuthLayout>
  );
}
