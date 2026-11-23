import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { roleHasCapability } from "@shared/capabilities";
import { useSession } from "@/lib/session";
import {
  Badge,
  Breadcrumbs,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  CopyButton,
  DateTime,
  EmptyState,
  ErrorState,
  KeyValueList,
  PageHeader,
  Skeleton,
  StepUpCancelledError,
  useStepUp,
  useToast,
} from "@/ui";
import {
  AGGREGATE_LABELS,
  CHART_TYPE_LABELS,
  describeReportError,
  downloadReportCsv,
  humanizeCode,
} from "../format";
import { ReportResultSection } from "../ReportChart";
import { REPORT_LIMITS, useReportsProcedures } from "../types";

export default function CustomReportRunPage() {
  const params = useParams<{ definitionId?: string }>();
  const definitionId = params.definitionId ?? "";

  const { me } = useSession();
  const role = me?.user.role;
  const reports = useReportsProcedures();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();
  const [, setLocation] = useLocation();

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const catalogueQuery = useQuery(reports.catalogue.queryOptions());
  const definitionQuery = useQuery(
    reports.custom.get.queryOptions(
      { definitionId },
      { enabled: Boolean(definitionId), retry: false },
    ),
  );

  const canRun = Boolean(definitionId) && (definitionQuery.data ? definitionQuery.data.valid : false);
  const runMutation = useMutation(reports.custom.run.mutationOptions());
  const { mutate: triggerRun } = runMutation;
  const lastAutoRanKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!canRun || !definitionQuery.data) return;
    const autoKey = `${definitionId}:${definitionQuery.data.version}`;
    if (lastAutoRanKeyRef.current === autoKey) return;
    lastAutoRanKeyRef.current = autoKey;
    triggerRun({ definitionId });
  }, [canRun, definitionId, definitionQuery.data, triggerRun]);

  const canExport = catalogueQuery.data
    ? catalogueQuery.data.canExport
    : role
      ? roleHasCapability(role, "reports.export")
      : false;
  const screenRowCap = catalogueQuery.data?.limits.screenRows ?? REPORT_LIMITS.screenRows;

  const duplicateMutation = useMutation(
    reports.custom.duplicate.mutationOptions({
      onSuccess: (copy) => {
        setActionError(null);
        void queryClient.invalidateQueries();
        toast.show({
          tone: "success",
          title: "Custom report duplicated",
          description: `Created "${copy.name}".`,
        });
        setLocation(`/admin/reports/custom/${copy.definitionId}/edit`);
      },
      onError: (err) => {
        setActionError(describeReportError(err).message);
      },
    }),
  );

  const deleteMutation = useMutation(
    reports.custom.delete.mutationOptions({
      onSuccess: () => {
        const deletedName = definitionQuery.data?.name ?? "Custom report";
        setConfirmDeleteOpen(false);
        void queryClient.invalidateQueries();
        toast.show({
          tone: "success",
          title: "Custom report deleted",
          description: `"${deletedName}" was deleted.`,
        });
        setLocation("/admin/reports");
      },
      onError: (err) => {
        setConfirmDeleteOpen(false);
        setActionError(describeReportError(err).message);
      },
    }),
  );

  const exportMutation = useMutation(reports.custom.export.mutationOptions());

  const datasetLabel = useMemo(() => {
    const def = definitionQuery.data;
    if (!def) return "";
    const match = catalogueQuery.data?.datasets.find((d) => d.key === def.dataset);
    return match?.label ?? humanizeCode(def.dataset);
  }, [catalogueQuery.data?.datasets, definitionQuery.data]);

  async function handleExportCsv() {
    const def = definitionQuery.data;
    if (!def) return;
    setActionError(null);
    setExporting(true);
    try {
      const csv = await stepUp.run(
        () => exportMutation.mutateAsync({ definitionId: def.definitionId }),
        { reason: `Export custom report "${def.name}" as CSV.` },
      );
      downloadReportCsv(csv);
      toast.show({
        tone: "success",
        title: "CSV export ready",
        description: csv.truncated
          ? `Downloaded ${csv.rowCount.toLocaleString()} rows (capped at CSV row limit).`
          : `Downloaded ${csv.rowCount.toLocaleString()} rows.`,
      });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      setActionError(describeReportError(err).message);
    } finally {
      setExporting(false);
    }
  }

  if (!definitionId) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <Breadcrumbs items={[{ label: "Reports", href: "/admin/reports" }, { label: "Not found" }]} />
        <PageHeader title="Custom report not found" />
        <EmptyState
          title="Missing custom report identifier"
          action={
            <Button asChild>
              <Link href="/admin/reports">Back to Reports</Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (definitionQuery.isPending) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <Breadcrumbs items={[{ label: "Reports", href: "/admin/reports" }, { label: "Loading…" }]} />
        <PageHeader title="Custom report" />
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (definitionQuery.error || !definitionQuery.data) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <Breadcrumbs items={[{ label: "Reports", href: "/admin/reports" }, { label: "Custom report" }]} />
        <PageHeader title="Custom report" />
        <ErrorState error={definitionQuery.error} onRetry={() => void definitionQuery.refetch()} />
      </div>
    );
  }

  const def = definitionQuery.data;
  const isGrouped = def.spec.groupBy.length > 0 || def.spec.aggregates.length > 0;
  const runErrorInfo = runMutation.error ? describeReportError(runMutation.error) : null;
  const isRunning = runMutation.isPending || (canRun && !runMutation.data && !runMutation.error);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumbs
        items={[
          { label: "Reports", href: "/admin/reports" },
          { label: def.name },
        ]}
      />

      <PageHeader
        title={def.name}
        description={
          def.description ||
          `${datasetLabel} custom report (${CHART_TYPE_LABELS[def.spec.chart]}).`
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={!def.valid}
              loading={runMutation.isPending}
              onClick={() => runMutation.mutate({ definitionId })}
            >
              <RefreshCw aria-hidden="true" className="size-4" />
              Run again
            </Button>

            {canExport && def.valid ? (
              <Button
                variant="secondary"
                size="sm"
                loading={exporting}
                onClick={() => void handleExportCsv()}
              >
                <Download aria-hidden="true" className="size-4" />
                Export CSV
              </Button>
            ) : null}

            <Button
              variant="secondary"
              size="sm"
              loading={duplicateMutation.isPending}
              onClick={() => duplicateMutation.mutate({ definitionId: def.definitionId })}
            >
              <Copy aria-hidden="true" className="size-4" />
              Duplicate
            </Button>

            {def.ownedByMe ? (
              <>
                <Button variant="secondary" size="sm" asChild>
                  <Link href={`/admin/reports/custom/${def.definitionId}/edit`}>
                    <Pencil aria-hidden="true" className="size-4" />
                    Edit
                  </Link>
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setConfirmDeleteOpen(true)}
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                  Delete
                </Button>
              </>
            ) : null}
          </div>
        }
      />

      <Card className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={def.visibility === "shared" ? "info" : "neutral"}>
            {def.visibility === "shared" ? "Shared with administrators" : "Private"}
          </Badge>
          <Badge tone="neutral">
            {def.ownedByMe ? "Owned by you" : "Shared report (read-only)"}
          </Badge>
          {!def.valid ? <Badge tone="warning">Needs update</Badge> : null}
        </div>

        <KeyValueList
          items={[
            { label: "Dataset", value: datasetLabel },
            {
              label: "Query structure",
              value: isGrouped
                ? `Grouped (${def.spec.groupBy.map((g) => (g.bucket ? `${g.field} by ${g.bucket}` : g.field)).join(", ") || "overall"}) · ${def.spec.aggregates.map((a) => (a.field ? `${AGGREGATE_LABELS[a.fn]} (${a.field})` : AGGREGATE_LABELS[a.fn])).join(", ")}`
                : `Detail rows (${def.spec.columns.length} columns)`,
            },
            {
              label: "Filters & row limit",
              value: `${def.spec.filters.length} ${def.spec.filters.length === 1 ? "filter" : "filters"} · limit ${def.spec.limit.toLocaleString()}`,
            },
            {
              label: "Definition hash",
              value: (
                <span className="inline-flex flex-wrap items-center gap-1.5 font-mono text-xs break-all">
                  <span>{def.specHash.slice(0, 16)}…</span>
                  <CopyButton value={def.specHash} label="Copy definition hash" />
                </span>
              ),
            },
            {
              label: "Last updated",
              value: <DateTime value={def.updatedAt} format="datetime" />,
            },
          ]}
        />
      </Card>

      {!def.valid ? (
        <Callout
          tone="warning"
          title="Definition needs updating before running"
          actions={
            def.ownedByMe ? (
              <Button size="sm" asChild>
                <Link href={`/admin/reports/custom/${def.definitionId}/edit`}>
                  Edit definition
                </Link>
              </Button>
            ) : (
              <Button
                size="sm"
                loading={duplicateMutation.isPending}
                onClick={() => duplicateMutation.mutate({ definitionId: def.definitionId })}
              >
                Duplicate to update
              </Button>
            )
          }
        >
          One or more fields referenced in this saved report are no longer in the dataset whitelist. Update the definition to run it again.
        </Callout>
      ) : null}

      {actionError ? (
        <Callout tone="danger" title="Report action failed">
          {actionError}
        </Callout>
      ) : null}

      {runErrorInfo ? (
        <Callout
          tone="danger"
          title={runErrorInfo.title}
          actions={
            <Button variant="secondary" size="sm" onClick={() => runMutation.mutate({ definitionId })}>
              Retry run
            </Button>
          }
        >
          {runErrorInfo.message}
        </Callout>
      ) : null}

      {def.valid ? (
        <ReportResultSection
          title="Results"
          headingLevel={2}
          description={
            runMutation.data ? (
              <>
                Generated <DateTime value={runMutation.data.generatedAt} format="datetime" />
              </>
            ) : undefined
          }
          chart={runMutation.data?.chart ?? def.spec.chart}
          table={
            runMutation.data ?? {
              columns: [],
              rows: [],
              rowCount: 0,
              truncated: false,
            }
          }
          loading={isRunning}
          screenRowCap={screenRowCap}
        />
      ) : null}

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title="Delete custom report?"
        description={`Permanently delete "${def.name}"? This cannot be undone.`}
        confirmLabel="Delete report"
        destructive
        onConfirm={async () => {
          await deleteMutation.mutateAsync({
            definitionId: def.definitionId,
            expectedVersion: def.version,
          });
        }}
      />
    </div>
  );
}
