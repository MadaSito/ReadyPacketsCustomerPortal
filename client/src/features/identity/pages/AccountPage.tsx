/** /account — profile (name), account facts and a link to the Security page (password, sessions, activity). */
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { useRefreshSession, useSession } from "@/lib/session";
import { errorMessage, useTRPC } from "@/lib/trpc";
import type { MeUser } from "@/lib/authApi";
import { Button, Card, ErrorState, KeyValueList, PageHeader, Skeleton, useToast } from "@/ui";
import { NameFields, validateNameParts, type NameErrors, type NameValues } from "../NameFields";
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
        <ProfileCard key={me.user.publicId} user={me.user} />
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

/** D1: accounts from before increment 08 see their derived first/last name pre-filled; saving stores the parts. */
export function initialNameValues(user: Pick<MeUser, "name" | "firstName" | "lastName" | "preferredName">): NameValues {
  if (user.firstName !== undefined || user.lastName !== undefined) {
    return { firstName: user.firstName ?? "", lastName: user.lastName ?? "", preferredName: user.preferredName ?? "" };
  }
  const tokens = user.name.trim().split(/\s+/).filter(Boolean);
  return { firstName: tokens[0] ?? "", lastName: tokens.length > 1 ? tokens[tokens.length - 1]! : "", preferredName: "" };
}

function ProfileCard({ user }: { user: MeUser }) {
  const trpc = useTRPC();
  const toast = useToast();
  const refresh = useRefreshSession();
  const [names, setNames] = useState<NameValues>(() => initialNameValues(user));
  const [errors, setErrors] = useState<NameErrors>({});
  const [error, setError] = useState<string>();
  const update = useMutation(trpc.identity.profile.update.mutationOptions());
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const check = validateNameParts(names);
    setErrors(check.ok ? {} : check.errors);
    if (!check.ok) return;
    setError(undefined);
    try {
      await update.mutateAsync(check.data);
      await refresh();
      toast.show({ tone: "success", title: "Profile updated" });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Card title="Profile">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <NameFields value={names} onChange={setNames} errors={errors} />
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        <div className="flex justify-end"><Button type="submit" loading={update.isPending}>Save profile</Button></div>
      </form>
    </Card>
  );
}
