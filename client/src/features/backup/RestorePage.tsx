/**
 * /admin/backups/restore — read-only explanation of the operator restore procedure. Owner: audit engineer.
 * Web-initiated restore is deliberately NOT offered in this release (integrator decision): restore runs only from the
 * host CLI into an explicitly named isolated target with operator-supplied credentials. This page never mutates.
 */
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { Breadcrumbs, Button, Callout, CodeBlock, DateTime, ErrorState, PageHeader, Section, Skeleton } from "@/ui";
import { VerificationBadge } from "./BackupParts";
import { BASE, recommendedArchive, restoreCommand, type Archive } from "./model";

export function RecommendedBackup({ archive }: { archive: Archive | null }) {
  if (!archive) {
    return <Callout tone="warning" title="No verified backup available">Run and verify a backup before you need it. A restore should only start from a verified copy.</Callout>;
  }
  return (
    <div className="flex flex-col gap-2 text-body sm:flex-row sm:flex-wrap sm:items-center">
      <span>Most recent verified backup:</span>
      <DateTime value={archive.createdAt} format="datetime" />
      <VerificationBadge status={archive.verificationStatus} />
      <code className="text-xs break-all">{archive.publicId}</code>
      <Button asChild size="sm" variant="secondary"><Link href={`${BASE}/${encodeURIComponent(archive.publicId)}`}>Open backup</Link></Button>
    </div>
  );
}

export default function RestorePage() {
  const trpc = useTRPC();
  const list = useQuery(trpc.backup.admin.list.queryOptions({ limit: 50, state: "completed" }));
  const recommended = list.data ? recommendedArchive(list.data.items) : null;

  return (
    <>
      <PageHeader
        title="Restoring a backup"
        breadcrumbs={<Breadcrumbs items={[{ label: "Backups", href: BASE }, { label: "Restore procedure" }]} />}
        description="Restores are run by an operator on the server, not from this console."
      />
      <div className="space-y-8">
        <Callout tone="info" title="Why restore is not a button here">
          A restore replaces business data and account security state. To keep that power away from a browser session, it runs only
          from the host command line, into a separately named isolated database, using credentials the operator supplies there — never
          the live application&apos;s own database account.
        </Callout>

        <Section title="Which backup to use">
          {list.isPending ? <Skeleton lines={1} /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : <RecommendedBackup archive={recommended} />}
        </Section>

        <Section title="Operator procedure" description="Follow docs/operations/BACKUP_AND_RESTORE.md; it is the authoritative, current version of these steps.">
          <ol className="list-decimal space-y-2 ps-5 text-body">
            <li>Verify the backup from its page here, and confirm the backup encryption key is available on the host from its offline custody copy.</li>
            <li>Create a new, empty database and an empty storage folder for the restored copy, with their own credentials.</li>
            <li>On the server, run the restore command below. It asks for the exact typed confirmation and never accepts secrets as arguments.</li>
            <li>The tool restores into the isolated target, revokes every session, invalidates outstanding single-use links and download tickets, runs integrity checks, and writes a durable audit record.</li>
            <li>Before go-live, review every account changed since the backup was taken — status, role, password and MFA — as the runbook requires.</li>
          </ol>
        </Section>

        <Section title="Command" description="Replace the values in angle brackets. When restoring straight from this server's storage, --backup-id <BACKUP_PUBLIC_ID> may be used instead of --archive-file. Exit code 0 means restored and verified; 1 means refused or integrity failed; 78 means configuration error.">
          <CodeBlock label="Restore command for the operator" copyable>{restoreCommand(recommended?.publicId ?? null)}</CodeBlock>
        </Section>

        <Section title="Restore records">
          <p className="text-body">
            Restore drills recorded by the server appear on each backup&apos;s page under &ldquo;Restore drills&rdquo;, with their integrity and security-continuity results.
          </p>
        </Section>
      </div>
    </>
  );
}
