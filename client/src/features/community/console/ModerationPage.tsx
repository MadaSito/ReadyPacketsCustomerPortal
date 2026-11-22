/** /admin/community — review queue, reports and moderation log. Owner: audit_engineer (package M). */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, EyeOff, MessagesSquare, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { errorMessage } from "@/lib/trpc";
import { Badge, Breadcrumbs, Button, Callout, Card, ConfirmDialog, DataTable, DateTime, EmptyState, ErrorState, Field, Input, PageHeader, Select, Skeleton, Tabs, useToast } from "@/ui";
import { useCommunityApi, type QueueView } from "../api";
import { CommunityBody, hiddenBodyLabel } from "../text";

const HELD_REASON: Record<string, string> = {
  new_member: "First posts from a new member",
  held_word: "Contains a word on the review list",
  links: "Many links from a new member",
  reports: "Hidden after several reports",
};
const REPORT_REASON: Record<string, string> = {
  spam: "Spam",
  abuse: "Abusive",
  off_topic: "Off topic",
  personal_info: "Personal information",
  other: "Other",
};

type Pending = QueueView["pending"][number];

export default function ModerationPage() {
  const api = useCommunityApi();
  const qc = useQueryClient();
  const toast = useToast();
  const status = useQuery(api.status.queryOptions());
  const enabled = status.data?.enabled === true;
  const queue = useQuery({ ...api.mod.queue.queryOptions(), enabled });
  const log = useQuery({ ...api.mod.log.queryOptions({}), enabled });
  const moderate = useMutation(api.mod.post.mutationOptions());
  const resolve = useMutation(api.mod.reports.resolve.mutationOptions());
  const suspend = useMutation(api.mod.suspend.mutationOptions());
  const [confirmRemove, setConfirmRemove] = useState<Pending | null>(null);
  const [suspendTarget, setSuspendTarget] = useState<{ publicId: string; name: string } | null>(null);
  const [suspendDays, setSuspendDays] = useState("7");
  const [suspendReason, setSuspendReason] = useState("");

  const refresh = async () => {
    await qc.invalidateQueries(api.mod.queue.pathFilter());
    await qc.invalidateQueries(api.mod.log.pathFilter());
  };
  const act = async (post: Pending | { publicId: string }, action: "approve" | "hide" | "unhide" | "remove", done: string) => {
    try {
      await moderate.mutateAsync({ postPublicId: post.publicId, action });
      toast.show({ title: done, tone: "success" });
    } catch (error) {
      toast.show({ title: "Not changed", description: errorMessage(error), tone: "danger" });
    } finally {
      await refresh();
    }
  };
  const resolveReport = async (reportPublicId: string, outcome: "dismissed" | "actioned") => {
    try {
      await resolve.mutateAsync({ reportPublicId, outcome });
      toast.show({ title: outcome === "dismissed" ? "Report dismissed" : "Report marked as handled", tone: "success" });
    } catch (error) {
      toast.show({ title: "Not changed", description: errorMessage(error), tone: "danger" });
    } finally {
      await refresh();
    }
  };
  const doSuspend = async () => {
    if (!suspendTarget) return;
    try {
      const days = suspendDays === "indefinite" ? null : Number(suspendDays);
      await suspend.mutateAsync({ memberPublicId: suspendTarget.publicId, days, reason: suspendReason });
      toast.show({ title: `${suspendTarget.name} suspended from posting`, tone: "success" });
      setSuspendTarget(null);
      setSuspendReason("");
    } catch (error) {
      toast.show({ title: "Not suspended", description: errorMessage(error), tone: "danger" });
    } finally {
      await refresh();
    }
  };

  const header = (
    <PageHeader
      breadcrumbs={<Breadcrumbs items={[{ label: "Console", href: "/admin" }, { label: "Community moderation" }]} />}
      title="Community moderation"
      description="Review held posts, handle reports and see every moderation action."
      actions={status.data?.canManage ? <Button asChild variant="secondary"><Link href="/admin/community/settings">Community settings</Link></Button> : undefined}
    />
  );
  if (status.isPending) return <>{header}<Skeleton className="h-40" /></>;
  if (status.isError) return <>{header}<ErrorState error={status.error} /></>;
  if (!enabled) {
    return (
      <>
        {header}
        <Callout tone="info" title="The community forum is switched off">
          Nothing is visible to customers. {status.data?.canManage ? "An administrator can switch it on in Community settings." : "Ask an administrator to switch it on."}
        </Callout>
      </>
    );
  }

  const pending = queue.data?.pending ?? [];
  const reports = queue.data?.reports ?? [];
  const pendingTab = queue.isError ? (
    <ErrorState error={queue.error} />
  ) : queue.isPending ? (
    <Skeleton className="h-40" />
  ) : pending.length === 0 ? (
    <EmptyState icon={MessagesSquare} title="Nothing waiting for review" description="Held and hidden posts appear here." />
  ) : (
    <ul className="space-y-4" aria-label="Posts waiting for review">
      {pending.map((p) => (
        <li key={p.publicId}>
          <Card
            as="article"
            headingLevel={2}
            title={p.topicTitle || "Topic"}
            description={
              <span className="flex flex-wrap items-center gap-2">
                <span>{p.author.displayName}</span>
                {p.author.staff && <Badge tone="info">Staff</Badge>}
                <Badge tone={p.state === "pending" ? "warning" : "neutral"}>{p.state === "pending" ? "Waiting for review" : "Hidden"}</Badge>
                {p.heldReason && <span className="text-muted">{HELD_REASON[p.heldReason] ?? p.heldReason}</span>}
                <DateTime value={p.createdAt} />
              </span>
            }
            footer={
              <div className="flex flex-wrap gap-2">
                {p.state === "pending" && <Button size="sm" leadingIcon={<Check className="size-4" aria-hidden />} onClick={() => void act(p, "approve", "Post approved and published")}>Approve</Button>}
                {p.state === "hidden" && <Button size="sm" onClick={() => void act(p, "unhide", "Post visible again")}>Show again</Button>}
                {p.state === "pending" && <Button size="sm" variant="secondary" leadingIcon={<EyeOff className="size-4" aria-hidden />} onClick={() => void act(p, "hide", "Post hidden")}>Hide</Button>}
                <Button size="sm" variant="danger" leadingIcon={<Trash2 className="size-4" aria-hidden />} onClick={() => setConfirmRemove(p)}>Remove</Button>
                {p.author.publicId && !p.author.staff && (
                  <Button size="sm" variant="ghost" leadingIcon={<Ban className="size-4" aria-hidden />} onClick={() => setSuspendTarget({ publicId: p.author.publicId!, name: p.author.displayName })}>Suspend member</Button>
                )}
                {p.topicPublicId && <Button asChild size="sm" variant="ghost"><Link href={`/community/t/${p.topicPublicId}`}>Open topic</Link></Button>}
              </div>
            }
          >
            {p.body !== null ? <CommunityBody text={p.body} /> : <p className="text-sm text-muted">{hiddenBodyLabel(p.state)}</p>}
          </Card>
        </li>
      ))}
    </ul>
  );

  const reportsTab = (
    <DataTable
      caption="Open reports"
      rows={queue.data ? reports : undefined}
      rowKey={(r) => r.publicId}
      loading={queue.isPending}
      empty={<EmptyState title="No open reports" description="Reports from members appear here." />}
      columns={[
        { key: "reason", header: "Reason", primary: true, cell: (r) => <span>{REPORT_REASON[r.reason] ?? r.reason}</span> },
        { key: "note", header: "Note from the member", cell: (r) => <span className="break-words">{r.note ?? "None"}</span> },
        { key: "count", header: "Open reports on this post", cell: (r) => r.openReportsOnPost },
        { key: "when", header: "Reported", cell: (r) => <DateTime value={r.createdAt} /> },
        {
          key: "actions",
          header: "Actions",
          cell: (r) => (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void act({ publicId: r.postPublicId }, "hide", "Post hidden").then(() => resolveReport(r.publicId, "actioned"))}>Hide post</Button>
              <Button size="sm" variant="ghost" onClick={() => void resolveReport(r.publicId, "dismissed")}>Dismiss</Button>
              {r.topicPublicId && <Button asChild size="sm" variant="ghost"><Link href={`/community/t/${r.topicPublicId}`}>Open topic</Link></Button>}
            </div>
          ),
        },
      ]}
    />
  );

  const logTab = (
    <DataTable
      caption="Moderation log"
      rows={log.data?.items}
      rowKey={(r) => r.publicId}
      loading={log.isPending}
      empty={<EmptyState title="No moderation actions yet" />}
      columns={[
        { key: "when", header: "When", primary: true, cell: (r) => <DateTime value={r.createdAt} /> },
        { key: "action", header: "Action", cell: (r) => r.action.replace(/_/gu, " ") },
        { key: "target", header: "Target", cell: (r) => <span>{r.targetType} <span className="font-mono text-xs break-all">{r.targetPublicId}</span></span> },
        { key: "by", header: "By", cell: (r) => r.actor },
        { key: "reason", header: "Reason", cell: (r) => r.reason ?? "None" },
      ]}
    />
  );

  return (
    <>
      {header}
      <Tabs
        label="Moderation"
        items={[
          { value: "queue", label: "Review queue", badge: pending.length ? <Badge tone="warning">{pending.length}</Badge> : undefined, content: pendingTab },
          { value: "reports", label: "Reports", badge: reports.length ? <Badge tone="warning">{reports.length}</Badge> : undefined, content: reportsTab },
          { value: "log", label: "Moderation log", content: logTab },
        ]}
      />
      <ConfirmDialog
        open={confirmRemove !== null}
        onOpenChange={(o) => !o && setConfirmRemove(null)}
        title="Remove this post?"
        description="Removed posts are no longer shown to members. The action is recorded in the moderation log."
        confirmLabel="Remove post"
        destructive
        onConfirm={async () => {
          if (confirmRemove) await act(confirmRemove, "remove", "Post removed");
          setConfirmRemove(null);
        }}
      />
      <ConfirmDialog
        open={suspendTarget !== null}
        onOpenChange={(o) => !o && setSuspendTarget(null)}
        title={`Suspend ${suspendTarget?.name ?? "member"} from posting?`}
        description="They can still read the community. The reason is kept in the moderation log."
        confirmLabel="Suspend"
        destructive
        onConfirm={doSuspend}
      >
        <div className="space-y-3">
          <Field label="Length">
            <Select value={suspendDays} onChange={(e) => setSuspendDays(e.target.value)} options={[{ value: "1", label: "1 day" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "indefinite", label: "Until lifted" }]} />
          </Field>
          <Field label="Reason" required hint="3 to 200 characters. Visible to moderators only.">
            <Input value={suspendReason} maxLength={200} onChange={(e) => setSuspendReason(e.target.value)} />
          </Field>
        </div>
      </ConfirmDialog>
    </>
  );
}
