import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ToggleLeft } from "lucide-react";
import { useTRPC } from "@/lib/trpc";
import { Callout, Card, EmptyState, ErrorState, PageHeader, Skeleton, Switch } from "@/ui";
import type { SettingView } from "../model";
import { PlatformNav } from "../PlatformNav";
import { useGuarded } from "../useGuarded";

export function FeaturesView({ flags, pendingKey, onToggle }: { flags: SettingView[]; pendingKey: string | null; onToggle: (flag: SettingView, enabled: boolean) => void }) {
  if (flags.length === 0) return <EmptyState icon={ToggleLeft} title="No optional features" description="Modules have not declared any optional features yet." />;
  return (
    <Card title="Optional features" description="Every feature starts off. Turning one on takes effect within a few seconds on every server.">
      <ul className="divide-y divide-line">
        {flags.map((flag) => (
          <li key={flag.key} className="py-3">
            <Switch label={flag.label} description={flag.description} checked={flag.value === true} disabled={pendingKey === flag.key} onCheckedChange={(enabled) => onToggle(flag, enabled)} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function FeaturesPage() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const guarded = useGuarded();
  const list = useQuery(trpc.platform.admin.features.list.queryOptions());
  const set = useMutation(trpc.platform.admin.features.set.mutationOptions());
  return (
    <>
      <PageHeader title="Features" description="Turn optional capabilities on or off for the whole installation." />
      <PlatformNav />
      <Callout tone="info" className="mb-6">Changes need verification and are recorded in the audit log.</Callout>
      {list.isPending ? (
        <div aria-busy="true"><Skeleton lines={4} /></div>
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <FeaturesView
          flags={list.data as SettingView[]}
          pendingKey={set.isPending ? (set.variables?.key ?? null) : null}
          onToggle={async (flag, enabled) => {
            await guarded(() => set.mutateAsync({ key: flag.key, enabled, expectedVersion: flag.version }), {
              success: enabled ? `${flag.label} turned on` : `${flag.label} turned off`,
              failure: "The feature was not changed",
            });
            await client.invalidateQueries({ queryKey: trpc.platform.admin.features.list.queryKey() });
          }}
        />
      )}
    </>
  );
}
