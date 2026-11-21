/** /account — profile (name), account facts, password change, links to sessions and security. */
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { useRefreshSession, useSession } from "@/lib/session";
import { errorMessage, safeError, useTRPC } from "@/lib/trpc";
import { Button, Callout, Card, ErrorState, Field, Input, KeyValueList, PageHeader, Skeleton, useToast } from "@/ui";
import { PASSWORD_POLICY, countCodePoints } from "@shared/domain";
import { ROLE_LABELS, UserStatusBadge } from "../shared";
import { SsoLinkCard } from "../sso/SsoLinkCard";

const header = <PageHeader title="Your account" description="Your profile, sign-in password and active sessions." />;

export default function AccountPage() {
  const { me, query } = useSession();
  if (query.isPending) {
    return <>{header}<div role="status" className="flex flex-col gap-3"><span className="sr-only">Loading your account</span><Skeleton lines={4} /></div></>;
  }
  if (!me) return <>{header}<ErrorState error={query.error} onRetry={() => void query.refetch()} /></>;
  return (
    <>
      {header}
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <ProfileCard key={me.user.publicId} name={me.user.name} />
        <Card title="Account details">
          <KeyValueList
            columns={1}
            items={[
              { label: "E-mail address", value: <span className="break-all">{me.user.email}</span> },
              ...(me.user.customerRef ? [{ label: "Customer reference", value: me.user.customerRef }] : []),
              { label: "Role", value: ROLE_LABELS[me.user.role] },
              { label: "Status", value: <UserStatusBadge status={me.user.status} /> },
            ]}
          />
          <p className="mt-4 text-sm text-muted">To change your e-mail address, contact support so we can verify the request.</p>
        </Card>
        <PasswordCard />
        <Card title="Sign-in and security" description="Review where you are signed in and manage verification methods.">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button asChild variant="secondary"><Link href="/account/sessions">Manage sessions</Link></Button>
            <Button asChild variant="secondary"><Link href="/account/security">Verification methods</Link></Button>
          </div>
        </Card>
        <SsoLinkCard />
      </div>
    </>
  );
}

function ProfileCard({ name: initial }: { name: string }) {
  const trpc = useTRPC();
  const toast = useToast();
  const refresh = useRefreshSession();
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string>();
  const update = useMutation(trpc.identity.profile.update.mutationOptions());
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError("Enter your name.");
    setError(undefined);
    try {
      await update.mutateAsync({ name: trimmed });
      await refresh();
      toast.show({ tone: "success", title: "Profile updated" });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Card title="Profile">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Field label="Full name" required error={error}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} />
        </Field>
        <div className="flex justify-end"><Button type="submit" loading={update.isPending}>Save profile</Button></div>
      </form>
    </Card>
  );
}

function PasswordCard() {
  const trpc = useTRPC();
  const toast = useToast();
  const refresh = useRefreshSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string; form?: string }>({});
  const change = useMutation(trpc.identity.changePassword.mutationOptions());
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const length = countCodePoints(next.normalize("NFC"));
    const found: typeof errors = {};
    if (!current) found.current = "Enter your current password.";
    if (length < PASSWORD_POLICY.minLength) found.next = `Use at least ${PASSWORD_POLICY.minLength} characters.`;
    else if (length > PASSWORD_POLICY.maxLength) found.next = `Use at most ${PASSWORD_POLICY.maxLength} characters.`;
    if (confirm !== next) found.confirm = "The passwords do not match.";
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    try {
      await change.mutateAsync({ currentPassword: current, newPassword: next });
      setCurrent(""); setNext(""); setConfirm("");
      await refresh();
      toast.show({ tone: "success", title: "Password changed", description: "Your other sessions were signed out." });
    } catch (err) {
      const safe = safeError(err);
      if (safe?.reasonCode === "CURRENT_PASSWORD_INCORRECT") setErrors({ current: safe.safeMessage });
      else if (safe?.reasonCode?.startsWith("PASSWORD_")) setErrors({ next: safe.safeMessage });
      else setErrors({ form: errorMessage(err) });
    }
  };
  return (
    <Card title="Password" description={`Use a passphrase of ${PASSWORD_POLICY.minLength} or more characters. Changing it signs out your other sessions.`}>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {errors.form ? <Callout tone="danger" live="assertive">{errors.form}</Callout> : null}
        <Field label="Current password" required error={errors.current}>
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </Field>
        <Field label="New password" required error={errors.next} hint={`${PASSWORD_POLICY.minLength}–${PASSWORD_POLICY.maxLength} characters. Spaces and any characters are allowed.`}>
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="Confirm new password" required error={errors.confirm}>
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </Field>
        <div className="flex justify-end"><Button type="submit" loading={change.isPending}>Change password</Button></div>
      </form>
    </Card>
  );
}
