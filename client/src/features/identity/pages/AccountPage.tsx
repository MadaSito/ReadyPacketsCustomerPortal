/** /account — profile (name), account facts and a link to the Security page (password, sessions, activity). */
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { useRefreshSession, useSession } from "@/lib/session";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Button, Card, ErrorState, Field, Input, KeyValueList, PageHeader, Skeleton, useToast } from "@/ui";
import { ROLE_LABELS, UserStatusBadge } from "../shared";
import { SsoLinkCard } from "../sso/SsoLinkCard";

const header = <PageHeader title="Your account" description="Your profile and account details." />;

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
        <Card title="Sign-in and security" description="Change your password, review where you are signed in and recent sign-in activity, and manage verification methods.">
          <Button asChild variant="secondary"><Link href="/account/security">Open security settings</Link></Button>
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
