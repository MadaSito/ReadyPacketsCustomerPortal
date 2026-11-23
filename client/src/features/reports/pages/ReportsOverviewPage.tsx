import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ArrowRight, Copy, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { roleHasCapability } from "@shared/capabilities";
import { useSession } from "@/lib/session";
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  DataTable,
  DateTime,
  EmptyState,
  ErrorState,
  LoadMore,
  PageHeader,
  Section,
  SegmentedControl,
  Skeleton,
  useToast,
  type Column,
} from "@/ui";
import {
  BUILT_IN_META,
  CHART_TYPE_LABELS,
  describeReportError,
  FALLBACK_BUILT_INS,
  humanizeCode,
} from "../format";
import {
  useReportsProcedures,
  type BuiltInKey,
  type CustomListScope,
  type DefinitionView,
} from "../types";

export default function ReportsOverviewPage() {
  const { me } = useSession();
  const role = me?.user.role;
  const reports = useReportsProcedures();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [, setLocation] = useLocation();

  const [scope, setScope] = useState<CustomListScope>("all");
  const [deleteTarget, setDeleteTarget] = useState<DefinitionView | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const catalogueQuery = useQuery(reports.catalogue.queryOptions());

  const canManage = catalogueQuery.data
    ? catalogueQuery.data.canManage
    : role
      ? roleHasCapability(role, "reports.manage")
      : false;

  const customListQuery = useInfiniteQuery(
    reports.custom.list.infiniteQueryOptions(
      { scope },
      {
        enabled: canManage,
        getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      },
    ),
  );

  const builtIns = catalogueQuery.data?.builtIns?.length
    ? catalogueQuery.data.builtIns
    : FALLBACK_BUILT_INS;

  const datasetLabelByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const ds of catalogueQuery.data?.datasets ?? []) {
      map.set(ds.key, ds.label);
    }
    return map;
  }, [catalogueQuery.data?.datasets]);

  const customItems = useMemo(
    () => customListQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [customListQuery.data?.pages],
  );

  const duplicateMutation = useMutation(
    reports.custom.duplicate.mutationOptions({
      onSuccess: (created) => {
        setActionError(null);
        void queryClient.invalidateQueries();
        toast.show({
          tone: "success",
          title: "Custom report duplicated",
          description: `Created "${created.name}".`,
        });
        setLocation(`/admin/reports/custom/${created.definitionId}/edit`);
      },
      onError: (err) => {
        setActionError(describeReportError(err).message);
      },
    }),
  );

  const deleteMutation = useMutation(
    reports.custom.delete.mutationOptions({
      onSuccess: () => {
        const removedName = deleteTarget?.name ?? "Report";
        setDeleteTarget(null);
        setActionError(null);
        void queryClient.invalidateQueries();
        toast.show({
          tone: "success",
          title: "Custom report deleted",
          description: `"${removedName}" was deleted.`,
        });
      },
      onError: (err) => {
        setDeleteTarget(null);
        setActionError(describeReportError(err).message);
      },
    }),
  );

  const customColumns: readonly Column<DefinitionView>[] = useMemo(
    () => [
      {
        key: "name",
        header: "Report",
        primary: true,
        cell: (row) => (
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/admin/reports/custom/${row.definitionId}`}
                className="font-medium break-words text-link underline underline-offset-2 hover:text-link-hover"
              >
                {row.name}
              </Link>
              {!row.valid ? <Badge tone="warning">Needs update</Badge> : null}
            </div>
            {row.description ? (
              <p className="text-xs break-words text-muted">{row.description}</p>
            ) : null}
          </div>
        ),
      },
      {
        key: "dataset",
        header: "Dataset & view",
        cell: (row) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-ink">
              {datasetLabelByKey.get(row.dataset) ?? humanizeCode(row.dataset)}
            </span>
            <span className="text-xs text-muted">
              {CHART_TYPE_LABELS[row.spec.chart] ?? row.spec.chart}
            </span>
          </div>
        ),
      },
      {
        key: "visibility",
        header: "Sharing",
        cell: (row) => (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={row.visibility === "shared" ? "info" : "neutral"}>
              {row.visibility === "shared" ? "Shared" : "Private"}
            </Badge>
            <span className="text-xs text-muted">
              {row.ownedByMe ? "Owned by you" : "Shared with admins"}
            </span>
          </div>
        ),
      },
      {
        key: "updatedAt",
        header: "Last updated",
        cell: (row) => <DateTime value={row.updatedAt} format="datetime" />,
      },
    ],
    [datasetLabelByKey],
  );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="Reports"
        description="Operational metrics across orders, customers, referrals, support tickets, payments, carts, files, and security."
        actions={
          canManage ? (
            <Button asChild>
              <Link href="/admin/reports/custom/new">
                <Plus aria-hidden="true" className="size-4" />
                New custom report
              </Link>
            </Button>
          ) : undefined
        }
      />

      {catalogueQuery.error ? (
        <ErrorState error={catalogueQuery.error} onRetry={() => void catalogueQuery.refetch()} />
      ) : null}

      <Section
        title="Built-in reports"
        description="Standard operational reports with date-range filtering, period-over-period comparison, accessible charts, and data tables."
      >
        {catalogueQuery.isPending && !catalogueQuery.data ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, idx) => (
              <Skeleton key={idx} className="h-44" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {builtIns.map((item) => {
              const meta = BUILT_IN_META[item.key as BuiltInKey] ?? BUILT_IN_META.orders;
              const Icon = meta.icon;
              return (
                <Card
                  key={item.key}
                  className="flex h-full min-w-0 flex-col justify-between gap-4"
                >
                  <div className="flex min-w-0 flex-col gap-2">
                    <div className="flex items-center gap-2.5">
                      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-line bg-surface-sunken text-ink">
                        <Icon aria-hidden="true" className="size-4" />
                      </span>
                      <h3 className="min-w-0 text-base font-semibold break-words text-ink">
                        {item.title}
                      </h3>
                    </div>
                    <p className="text-sm break-words text-muted">{item.description}</p>
                  </div>
                  <div className="flex items-center justify-end pt-1">
                    <Button variant="secondary" size="sm" asChild>
                      <Link href={`/admin/reports/built-in/${item.key}`}>
                        Open {item.title}
                        <ArrowRight aria-hidden="true" className="size-4" />
                      </Link>
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </Section>

      {canManage ? (
        <Section
          title="Custom reports"
          description="Saved whitelisted dataset reports for administrators. Shared reports are runnable by every administrator; only the owner can edit or delete."
          actions={
            <SegmentedControl
              label="Filter saved custom reports"
              size="sm"
              value={scope}
              onValueChange={setScope}
              options={[
                { value: "all", label: "All" },
                { value: "mine", label: "Mine" },
                { value: "shared", label: "Shared" },
              ]}
            />
          }
        >
          <div className="flex min-w-0 flex-col gap-4">
            {actionError ? (
              <Callout tone="danger" title="Report action failed">
                {actionError}
              </Callout>
            ) : null}

            <DataTable
              caption="Saved custom reports"
              columns={customColumns}
              rows={customListQuery.data ? customItems : undefined}
              rowKey={(row) => row.definitionId}
              loading={customListQuery.isPending}
              error={customListQuery.error}
              onRetry={() => void customListQuery.refetch()}
              empty={
                <EmptyState
                  title="No saved custom reports yet"
                  description="Build a custom report from a whitelisted dataset with typed filters, groupings, and charts."
                  headingLevel={3}
                  action={
                    <Button asChild size="sm">
                      <Link href="/admin/reports/custom/new">
                        <Plus aria-hidden="true" className="size-4" />
                        Create custom report
                      </Link>
                    </Button>
                  }
                />
              }
              rowActions={(row) => (
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <Button variant="secondary" size="sm" asChild>
                    <Link
                      href={`/admin/reports/custom/${row.definitionId}`}
                      aria-label={`Run ${row.name}`}
                    >
                      <Play aria-hidden="true" className="size-3.5" />
                      Run
                    </Link>
                  </Button>
                  {row.ownedByMe ? (
                    <Button variant="ghost" size="sm" asChild>
                      <Link
                        href={`/admin/reports/custom/${row.definitionId}/edit`}
                        aria-label={`Edit ${row.name}`}
                      >
                        <Pencil aria-hidden="true" className="size-3.5" />
                        Edit
                      </Link>
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={
                      duplicateMutation.isPending &&
                      duplicateMutation.variables?.definitionId === row.definitionId
                    }
                    onClick={() => duplicateMutation.mutate({ definitionId: row.definitionId })}
                    aria-label={`Duplicate ${row.name}`}
                  >
                    <Copy aria-hidden="true" className="size-3.5" />
                    Duplicate
                  </Button>
                  {row.ownedByMe ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteTarget(row)}
                      aria-label={`Delete ${row.name}`}
                    >
                      <Trash2 aria-hidden="true" className="size-3.5" />
                      Delete
                    </Button>
                  ) : null}
                </div>
              )}
            />

            <LoadMore
              hasMore={Boolean(customListQuery.hasNextPage)}
              loading={customListQuery.isFetchingNextPage}
              onLoadMore={() => void customListQuery.fetchNextPage()}
            />
          </div>
        </Section>
      ) : null}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete custom report?"
        description={
          deleteTarget
            ? `Permanently delete "${deleteTarget.name}"? This cannot be undone.`
            : ""
        }
        confirmLabel="Delete report"
        destructive
        onConfirm={async () => {
          if (!deleteTarget) return;
          await deleteMutation.mutateAsync({
            definitionId: deleteTarget.definitionId,
            expectedVersion: deleteTarget.version,
          });
        }}
      />
    </div>
  );
}
