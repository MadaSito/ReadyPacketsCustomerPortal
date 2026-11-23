import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { Link, useParams } from "wouter";
import { roleHasCapability } from "@shared/capabilities";
import { useSession } from "@/lib/session";
import {
  Breadcrumbs,
  Button,
  Callout,
  Card,
  DateTime,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  StatCard,
  StatGrid,
  StepUpCancelledError,
  Switch,
  useStepUp,
  useToast,
} from "@/ui";
import {
  BUCKET_LABELS,
  BUILT_IN_META,
  computePresetDateStrings,
  DATE_PRESET_OPTIONS,
  describeReportError,
  downloadReportCsv,
  formatComparisonText,
  parseReportDateRange,
  renderMetricValueNode,
  type DatePreset,
} from "../format";
import { ReportResultSection } from "../ReportChart";
import {
  BUCKETS,
  BUILT_IN_KEYS,
  REPORT_LIMITS,
  useReportsProcedures,
  type Bucket,
  type BuiltInKey,
} from "../types";

function isBuiltInKey(value: string | undefined): value is BuiltInKey {
  return Boolean(value && (BUILT_IN_KEYS as readonly string[]).includes(value));
}

export default function BuiltInReportPage() {
  const params = useParams<{ reportKey?: string }>();
  const reportKey = params.reportKey;
  const validKey = isBuiltInKey(reportKey) ? reportKey : null;

  const { me } = useSession();
  const role = me?.user.role;
  const reports = useReportsProcedures();
  const stepUp = useStepUp();
  const toast = useToast();

  const initialDates = useMemo(() => computePresetDateStrings("30d"), []);
  const [preset, setPreset] = useState<DatePreset>("30d");
  const [fromDate, setFromDate] = useState<string>(initialDates.fromDate);
  const [toDate, setToDate] = useState<string>(initialDates.toDate);
  const [bucket, setBucket] = useState<Bucket>("day");
  const [comparePrevious, setComparePrevious] = useState<boolean>(true);
  const [fieldError, setFieldError] = useState<{ field: "from" | "to"; message: string } | null>(
    null,
  );
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportingPanel, setExportingPanel] = useState<string | null>(null);

  const [appliedRange, setAppliedRange] = useState<{ from: Date; to: Date }>(() => {
    const parsed = parseReportDateRange(initialDates.fromDate, initialDates.toDate);
    return parsed.ok
      ? { from: parsed.from, to: parsed.to }
      : { from: new Date(Date.now() - 30 * 86_400_000), to: new Date() };
  });

  const catalogueQuery = useQuery(reports.catalogue.queryOptions());
  const maxRangeDays = catalogueQuery.data?.limits.maxRangeDays ?? REPORT_LIMITS.maxRangeDays;
  const screenRowCap = catalogueQuery.data?.limits.screenRows ?? REPORT_LIMITS.screenRows;

  const canExport = catalogueQuery.data
    ? catalogueQuery.data.canExport
    : role
      ? roleHasCapability(role, "reports.export")
      : false;

  const runInput = useMemo(
    () =>
      validKey
        ? {
            key: validKey,
            range: appliedRange,
            comparePrevious,
            bucket,
          }
        : null,
    [appliedRange, bucket, comparePrevious, validKey],
  );

  const runQuery = useQuery(
    reports.builtIn.run.queryOptions(
      runInput ?? {
        key: "orders",
        range: appliedRange,
        comparePrevious,
        bucket,
      },
      { enabled: Boolean(runInput), retry: false },
    ),
  );

  const exportMutation = useMutation(reports.builtIn.export.mutationOptions());

  if (!validKey) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <Breadcrumbs items={[{ label: "Reports", href: "/admin/reports" }, { label: "Not found" }]} />
        <PageHeader title="Report not found" />
        <EmptyState
          title="Unknown built-in report"
          description="Choose one of the standard operational reports from the Reports overview."
          action={
            <Button asChild>
              <Link href="/admin/reports">Back to Reports</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const catalogueItem = catalogueQuery.data?.builtIns.find((b) => b.key === validKey);
  const meta = BUILT_IN_META[validKey];
  const pageTitle = runQuery.data?.title ?? catalogueItem?.title ?? meta.defaultTitle;
  const pageDescription = catalogueItem?.description ?? meta.defaultDescription;

  function handlePresetChange(next: DatePreset) {
    setPreset(next);
    setFieldError(null);
    if (next === "custom") return;
    const nextDates = computePresetDateStrings(next);
    setFromDate(nextDates.fromDate);
    setToDate(nextDates.toDate);
    const parsed = parseReportDateRange(nextDates.fromDate, nextDates.toDate, maxRangeDays);
    if (parsed.ok) {
      setAppliedRange({ from: parsed.from, to: parsed.to });
    }
  }

  function handleApplyRange(event: FormEvent) {
    event.preventDefault();
    const parsed = parseReportDateRange(fromDate, toDate, maxRangeDays);
    if (!parsed.ok) {
      setFieldError({ field: parsed.field, message: parsed.message });
      return;
    }
    setFieldError(null);
    setAppliedRange({ from: parsed.from, to: parsed.to });
  }

  async function handleExportPanel(panelKey: string, panelTitle: string) {
    if (!runInput) return;
    setExportError(null);
    setExportingPanel(panelKey);
    try {
      const csv = await stepUp.run(
        () =>
          exportMutation.mutateAsync({
            ...runInput,
            panel: panelKey,
          }),
        { reason: `Export "${panelTitle}" as CSV.` },
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
      setExportError(describeReportError(err).message);
    } finally {
      setExportingPanel(null);
    }
  }

  const runErrInfo = runQuery.error ? describeReportError(runQuery.error) : null;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumbs
        items={[
          { label: "Reports", href: "/admin/reports" },
          { label: pageTitle },
        ]}
      />

      <PageHeader
        title={pageTitle}
        description={pageDescription}
        actions={
          <Button
            variant="secondary"
            size="sm"
            loading={runQuery.isFetching}
            onClick={() => void runQuery.refetch()}
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Refresh
          </Button>
        }
      />

      <Card>
        <form onSubmit={handleApplyRange} className="flex min-w-0 flex-col gap-4" noValidate>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Date preset">
              <Select
                value={preset}
                onChange={(e) => handlePresetChange(e.target.value as DatePreset)}
                options={DATE_PRESET_OPTIONS}
              />
            </Field>

            <Field
              label="From (UTC)"
              error={fieldError?.field === "from" ? fieldError.message : undefined}
            >
              <Input
                type="date"
                value={fromDate}
                onChange={(e) => {
                  setPreset("custom");
                  setFromDate(e.target.value);
                  if (fieldError?.field === "from") setFieldError(null);
                }}
              />
            </Field>

            <Field
              label="To (UTC)"
              error={fieldError?.field === "to" ? fieldError.message : undefined}
            >
              <Input
                type="date"
                value={toDate}
                onChange={(e) => {
                  setPreset("custom");
                  setToDate(e.target.value);
                  if (fieldError?.field === "to") setFieldError(null);
                }}
              />
            </Field>

            <Field label="Time bucket">
              <Select
                value={bucket}
                onChange={(e) => setBucket(e.target.value as Bucket)}
                options={BUCKETS.map((b) => ({ value: b, label: BUCKET_LABELS[b] }))}
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line pt-3">
            <Switch
              checked={comparePrevious}
              onCheckedChange={setComparePrevious}
              label="Compare with previous period"
              description="Shows exact directional and percentage change against the preceding period of equal length."
            />

            <Button type="submit" variant="primary" size="sm">
              Apply date range
            </Button>
          </div>
        </form>
      </Card>

      {exportError ? (
        <Callout tone="danger" title="CSV export failed">
          {exportError}
        </Callout>
      ) : null}

      {runErrInfo ? (
        <Callout
          tone="danger"
          title={runErrInfo.title}
          actions={
            <Button variant="secondary" size="sm" onClick={() => void runQuery.refetch()}>
              Try again
            </Button>
          }
        >
          {runErrInfo.message}
        </Callout>
      ) : null}

      {runQuery.isPending && !runQuery.data ? (
        <div role="status" aria-label={`Loading ${pageTitle} report`} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, idx) => (
              <Skeleton key={idx} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-64" />
          <span className="sr-only">Loading {pageTitle} report</span>
        </div>
      ) : null}

      {runQuery.data ? (
        <>
          {runQuery.data.notes.length > 0 ? (
            <Callout tone="info" title="Report notes">
              <ul className="list-disc space-y-1 pl-4">
                {runQuery.data.notes.map((note, idx) => (
                  <li key={idx} className="break-words">
                    {note}
                  </li>
                ))}
              </ul>
            </Callout>
          ) : null}

          <p className="text-xs text-muted">
            Generated <DateTime value={runQuery.data.generatedAt} format="datetime" />
            {comparePrevious && runQuery.data.previousRange ? (
              <>
                {" · "}Comparing against previous period (
                <DateTime value={runQuery.data.previousRange.from} format="date" /> to{" "}
                <DateTime value={runQuery.data.previousRange.to} format="date" />)
              </>
            ) : null}
          </p>

          {runQuery.data.metrics.length > 0 ? (
            <section aria-label="Summary metrics">
              <StatGrid>
                {runQuery.data.metrics.map((metric) => (
                  <StatCard
                    key={metric.key}
                    label={metric.label}
                    value={renderMetricValueNode(metric)}
                    hint={formatComparisonText(metric, comparePrevious) ?? undefined}
                  />
                ))}
              </StatGrid>
            </section>
          ) : null}

          <div className="flex min-w-0 flex-col gap-6">
            {runQuery.data.panels.map((panel) => (
              <ReportResultSection
                key={panel.key}
                title={panel.title}
                headingLevel={2}
                chart={panel.chart}
                summary={panel.summary}
                table={panel}
                screenRowCap={screenRowCap}
                actions={
                  canExport ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={exportingPanel === panel.key}
                      onClick={() => void handleExportPanel(panel.key, panel.title)}
                      aria-label={`Export CSV: ${panel.title}`}
                    >
                      <Download aria-hidden="true" className="size-4" />
                      Export CSV
                    </Button>
                  ) : undefined
                }
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
