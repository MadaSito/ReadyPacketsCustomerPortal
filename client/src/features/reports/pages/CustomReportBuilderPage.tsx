import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Play, Plus, Save, Trash2 } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { Link, useLocation, useParams } from "wouter";
import {
  Badge,
  Breadcrumbs,
  Button,
  Callout,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  RadioGroup,
  Section,
  SegmentedControl,
  Select,
  Skeleton,
  TagInput,
  Textarea,
  useToast,
} from "@/ui";
import {
  AGGREGATE_LABELS,
  BUCKET_LABELS,
  CHART_TYPE_LABELS,
  describeReportError,
  FILTER_OP_LABELS,
  humanizeCode,
} from "../format";
import { ReportResultSection } from "../ReportChart";
import {
  AGGREGATES,
  CHART_TYPES,
  REPORT_LIMITS,
  useReportsProcedures,
  type Aggregate,
  type Bucket,
  type CatalogueView,
  type ChartType,
  type CustomResult,
  type DatasetView,
  type DefinitionView,
  type FieldView,
  type FilterOp,
  type ReportAggregate,
  type ReportFilter,
  type ReportGroupBy,
  type ReportScalar,
  type ReportSort,
  type ReportSpec,
  type ReportVisibility,
} from "../types";

type QueryMode = "detail" | "grouped";

interface DraftFilter {
  id: string;
  field: string;
  op: FilterOp;
  scalarText: string;
  rangeStartText: string;
  rangeEndText: string;
  listItems: string[];
}

interface DraftGroup {
  id: string;
  field: string;
  bucket: Bucket | "none";
}

interface DraftAggregate {
  id: string;
  fn: Aggregate;
  field: string;
}

interface DraftSort {
  id: string;
  key: string;
  dir: "asc" | "desc";
}

let nextDraftSeq = 1;
function makeDraftId(prefix: string): string {
  nextDraftSeq += 1;
  return `${prefix}-${nextDraftSeq}`;
}

function defaultScalarForField(field: FieldView | undefined): string {
  if (!field) return "";
  if (field.type === "boolean") return "true";
  if (field.type === "enum") return field.enumValues?.[0] ?? "";
  if (field.type === "number" || field.type === "money" || field.type === "duration") return "0";
  if (field.type === "datetime") return "2026-01-01";
  return "";
}

function coerceScalar(
  raw: string,
  field: FieldView,
): { ok: true; value: ReportScalar } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (field.type === "boolean") {
    return { ok: true, value: trimmed === "true" };
  }
  if (field.type === "number" || field.type === "money" || field.type === "duration") {
    if (trimmed === "") {
      return { ok: false, error: `Enter a numeric value for "${field.label}".` };
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num)) {
      return { ok: false, error: `"${field.label}" requires a valid number.` };
    }
    if (field.type === "money" && !Number.isInteger(num)) {
      return {
        ok: false,
        error: `"${field.label}" must be an integer in minor currency units (for example cents).`,
      };
    }
    return { ok: true, value: num };
  }
  if (trimmed.length === 0) {
    return { ok: false, error: `Enter a value for "${field.label}".` };
  }
  if (trimmed.length > 200) {
    return {
      ok: false,
      error: `Filter value for "${field.label}" must be 200 characters or fewer.`,
    };
  }
  if (field.type === "datetime" && /^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return { ok: true, value: `${trimmed}T00:00:00.000Z` };
  }
  return { ok: true, value: trimmed };
}

function aggregateSortKey(agg: DraftAggregate): string {
  if (agg.fn === "count" && !agg.field) return "count";
  return agg.field ? `${agg.fn}_${agg.field}` : "count";
}

function hydrateDraftFilters(
  filters: readonly ReportFilter[],
  dataset: DatasetView | undefined,
): DraftFilter[] {
  return filters.map((f) => {
    const fieldMeta = dataset?.fields.find((fld) => fld.key === f.field);
    let scalarText = defaultScalarForField(fieldMeta);
    let rangeStartText = "";
    let rangeEndText = "";
    let listItems: string[] = [];

    if (f.op === "between" && Array.isArray(f.value)) {
      rangeStartText = String(f.value[0] ?? "").replace(/T00:00:00\.000Z$/, "");
      rangeEndText = String(f.value[1] ?? "").replace(/T00:00:00\.000Z$/, "");
    } else if (f.op === "in" && Array.isArray(f.value)) {
      listItems = f.value.map(String);
    } else if (f.value !== undefined && !Array.isArray(f.value)) {
      scalarText = String(f.value).replace(/T00:00:00\.000Z$/, "");
    }

    return {
      id: makeDraftId("flt"),
      field: f.field,
      op: f.op,
      scalarText,
      rangeStartText,
      rangeEndText,
      listItems,
    };
  });
}

function defaultDetailColumns(ds: DatasetView): string[] {
  const nonPersonal = ds.fields
    .filter((f) => !f.personal)
    .slice(0, 4)
    .map((f) => f.key);
  return nonPersonal.length > 0 ? nonPersonal : ds.fields.slice(0, 4).map((f) => f.key);
}

interface BuilderFormProps {
  datasets: readonly DatasetView[];
  limits: CatalogueView["limits"];
  initialDefinition: DefinitionView | null;
}

function CustomReportBuilderForm({
  datasets,
  limits,
  initialDefinition,
}: BuilderFormProps) {
  const reports = useReportsProcedures();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [, setLocation] = useLocation();

  const initialDataset =
    (initialDefinition
      ? datasets.find((d) => d.key === initialDefinition.spec.dataset)
      : undefined) ?? datasets[0]!;
  const initialIsGrouped = Boolean(
    initialDefinition &&
      (initialDefinition.spec.groupBy.length > 0 ||
        initialDefinition.spec.aggregates.length > 0),
  );

  const [name, setName] = useState<string>(() => initialDefinition?.name ?? "");
  const [description, setDescription] = useState<string>(
    () => initialDefinition?.description ?? "",
  );
  const [visibility, setVisibility] = useState<ReportVisibility>(
    () => initialDefinition?.visibility ?? "private",
  );
  const [datasetKey, setDatasetKey] = useState<string>(() => initialDataset.key);
  const [mode, setMode] = useState<QueryMode>(() =>
    initialIsGrouped ? "grouped" : "detail",
  );
  const [selectedColumns, setSelectedColumns] = useState<string[]>(() =>
    initialDefinition && initialDefinition.spec.columns.length > 0
      ? [...initialDefinition.spec.columns]
      : defaultDetailColumns(initialDataset),
  );
  const [filters, setFilters] = useState<DraftFilter[]>(() =>
    initialDefinition
      ? hydrateDraftFilters(initialDefinition.spec.filters, initialDataset)
      : [],
  );
  const [groups, setGroups] = useState<DraftGroup[]>(() =>
    initialDefinition
      ? initialDefinition.spec.groupBy.map((g) => ({
          id: makeDraftId("grp"),
          field: g.field,
          bucket: g.bucket ?? "none",
        }))
      : [],
  );
  const [aggregates, setAggregates] = useState<DraftAggregate[]>(() =>
    initialDefinition && initialDefinition.spec.aggregates.length > 0
      ? initialDefinition.spec.aggregates.map((a) => ({
          id: makeDraftId("agg"),
          fn: a.fn,
          field: a.field ?? "",
        }))
      : [{ id: makeDraftId("agg"), fn: "count", field: "" }],
  );
  const [sorts, setSorts] = useState<DraftSort[]>(() =>
    initialDefinition
      ? initialDefinition.spec.sort.map((s) => ({
          id: makeDraftId("srt"),
          key: s.key,
          dir: s.dir,
        }))
      : [],
  );
  const [limitText, setLimitText] = useState<string>(() =>
    String(initialDefinition?.spec.limit ?? 1000),
  );
  const [chart, setChart] = useState<ChartType>(
    () => initialDefinition?.spec.chart ?? "table",
  );

  const [nameError, setNameError] = useState<string | null>(null);
  const [limitError, setLimitError] = useState<string | null>(null);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<CustomResult | null>(null);

  const activeDataset = useMemo(
    () => datasets.find((d) => d.key === datasetKey) ?? datasets[0]!,
    [datasetKey, datasets],
  );

  const groupableFields = useMemo(
    () => activeDataset.fields.filter((f) => f.groupable),
    [activeDataset],
  );

  const filterableFields = useMemo(
    () => activeDataset.fields.filter((f) => f.filterOps.length > 0),
    [activeDataset],
  );

  const availableSortOptions = useMemo(() => {
    if (mode === "detail") {
      return selectedColumns.map((colKey) => {
        const fld = activeDataset.fields.find((f) => f.key === colKey);
        return { value: colKey, label: fld?.label ?? colKey };
      });
    }
    const opts: { value: string; label: string }[] = [];
    const seen = new Set<string>();
    for (const grp of groups) {
      if (!grp.field || seen.has(grp.field)) continue;
      seen.add(grp.field);
      const fld = activeDataset.fields.find((f) => f.key === grp.field);
      opts.push({ value: grp.field, label: `Group: ${fld?.label ?? grp.field}` });
    }
    for (const agg of aggregates) {
      const key = aggregateSortKey(agg);
      if (seen.has(key)) continue;
      seen.add(key);
      const fld = activeDataset.fields.find((f) => f.key === agg.field);
      const label =
        agg.fn === "count" && !agg.field
          ? "Count rows"
          : `${AGGREGATE_LABELS[agg.fn]} (${fld?.label ?? agg.field})`;
      opts.push({ value: key, label });
    }
    return opts;
  }, [activeDataset, aggregates, groups, mode, selectedColumns]);

  const previewMutation = useMutation(
    reports.custom.preview.mutationOptions({
      onSuccess: (res) => {
        setBuilderError(null);
        setPreviewResult(res);
      },
      onError: (err) => {
        setBuilderError(describeReportError(err).message);
      },
    }),
  );

  const createMutation = useMutation(
    reports.custom.create.mutationOptions({
      onSuccess: (saved) => {
        setBuilderError(null);
        void queryClient.invalidateQueries();
        toast.show({
          tone: "success",
          title: "Custom report saved",
          description: `"${saved.name}" is ready to run.`,
        });
        setLocation(`/admin/reports/custom/${saved.definitionId}`);
      },
      onError: (err) => {
        setBuilderError(describeReportError(err).message);
      },
    }),
  );

  const updateMutation = useMutation(
    reports.custom.update.mutationOptions({
      onSuccess: (saved) => {
        setBuilderError(null);
        void queryClient.invalidateQueries();
        toast.show({
          tone: "success",
          title: "Changes saved",
          description: `"${saved.name}" was updated.`,
        });
        setLocation(`/admin/reports/custom/${saved.definitionId}`);
      },
      onError: (err) => {
        setBuilderError(describeReportError(err).message);
      },
    }),
  );

  function handleDatasetChange(nextKey: string) {
    const nextDs = datasets.find((d) => d.key === nextKey);
    setDatasetKey(nextKey);
    setPreviewResult(null);
    setBuilderError(null);
    if (!nextDs) return;
    setSelectedColumns(defaultDetailColumns(nextDs));
    setFilters([]);
    const firstGrp = nextDs.fields.find((f) => f.groupable);
    setGroups(
      mode === "grouped" && firstGrp
        ? [
            {
              id: makeDraftId("grp"),
              field: firstGrp.key,
              bucket: firstGrp.buckets[0] ?? "none",
            },
          ]
        : [],
    );
    setAggregates([{ id: makeDraftId("agg"), fn: "count", field: "" }]);
    setSorts([]);
  }

  function handleModeChange(nextMode: QueryMode) {
    setMode(nextMode);
    setSorts([]);
    setBuilderError(null);
    if (nextMode === "grouped") {
      if (groups.length === 0 && groupableFields.length > 0) {
        const first = groupableFields[0]!;
        setGroups([
          {
            id: makeDraftId("grp"),
            field: first.key,
            bucket: first.buckets[0] ?? "none",
          },
        ]);
      }
      if (aggregates.length === 0) {
        setAggregates([{ id: makeDraftId("agg"), fn: "count", field: "" }]);
      }
      if (chart === "table") {
        setChart("bar");
      }
    } else {
      if (selectedColumns.length === 0) {
        setSelectedColumns(defaultDetailColumns(activeDataset));
      }
      setChart("table");
    }
  }

  function toggleColumn(fieldKey: string, checked: boolean) {
    setSelectedColumns((prev) => {
      if (checked) {
        if (prev.includes(fieldKey) || prev.length >= 30) return prev;
        return [...prev, fieldKey];
      }
      const next = prev.filter((k) => k !== fieldKey);
      setSorts((prevSorts) => prevSorts.filter((s) => s.key !== fieldKey));
      return next;
    });
  }

  function compileSpec(): { ok: true; spec: ReportSpec } | { ok: false; error: string } {
    const parsedLimit = Number(limitText.trim());
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > limits.csvRows) {
      setLimitError(
        `Row limit must be an integer between 1 and ${limits.csvRows.toLocaleString()}.`,
      );
      return {
        ok: false,
        error: `Row limit must be between 1 and ${limits.csvRows.toLocaleString()}.`,
      };
    }
    setLimitError(null);

    const compiledFilters: ReportFilter[] = [];
    for (const draft of filters) {
      const fld = activeDataset.fields.find((f) => f.key === draft.field);
      if (!fld) {
        return { ok: false, error: `Unknown filter field "${draft.field}".` };
      }
      if (draft.op === "isNull" || draft.op === "isNotNull") {
        compiledFilters.push({ field: fld.key, op: draft.op });
        continue;
      }
      if (draft.op === "between") {
        const startVal = coerceScalar(draft.rangeStartText, fld);
        if (!startVal.ok) return { ok: false, error: startVal.error };
        const endVal = coerceScalar(draft.rangeEndText, fld);
        if (!endVal.ok) return { ok: false, error: endVal.error };
        compiledFilters.push({
          field: fld.key,
          op: "between",
          value: [startVal.value, endVal.value],
        });
        continue;
      }
      if (draft.op === "in") {
        if (draft.listItems.length === 0 || draft.listItems.length > 50) {
          return {
            ok: false,
            error: `Add between 1 and 50 values for "${fld.label}".`,
          };
        }
        const coercedList: ReportScalar[] = [];
        for (const rawItem of draft.listItems) {
          const itemRes = coerceScalar(rawItem, fld);
          if (!itemRes.ok) return { ok: false, error: itemRes.error };
          coercedList.push(itemRes.value);
        }
        compiledFilters.push({ field: fld.key, op: "in", value: coercedList });
        continue;
      }
      const single = coerceScalar(draft.scalarText, fld);
      if (!single.ok) return { ok: false, error: single.error };
      compiledFilters.push({ field: fld.key, op: draft.op, value: single.value });
    }

    let compiledColumns: string[] = [];
    let compiledGroups: ReportGroupBy[] = [];
    const compiledAggregates: ReportAggregate[] = [];

    if (mode === "detail") {
      if (selectedColumns.length === 0) {
        return { ok: false, error: "Select at least one column to include in the report." };
      }
      compiledColumns = selectedColumns;
    } else {
      compiledGroups = groups.map((g) => ({
        field: g.field,
        ...(g.bucket !== "none" ? { bucket: g.bucket } : {}),
      }));
      if (aggregates.length === 0) {
        return { ok: false, error: "Add at least one aggregate metric for a grouped report." };
      }
      for (const agg of aggregates) {
        if (agg.fn === "count") {
          compiledAggregates.push(agg.field ? { fn: "count", field: agg.field } : { fn: "count" });
        } else {
          if (!agg.field) {
            return {
              ok: false,
              error: `Choose a numeric field for the "${AGGREGATE_LABELS[agg.fn]}" aggregate.`,
            };
          }
          compiledAggregates.push({ fn: agg.fn, field: agg.field });
        }
      }
    }

    const validSortKeys = new Set(availableSortOptions.map((o) => o.value));
    const compiledSorts: ReportSort[] = sorts
      .filter((s) => validSortKeys.has(s.key))
      .map((s) => ({ key: s.key, dir: s.dir }));

    return {
      ok: true,
      spec: {
        dataset: activeDataset.key,
        columns: compiledColumns,
        filters: compiledFilters,
        groupBy: compiledGroups,
        aggregates: compiledAggregates,
        sort: compiledSorts,
        limit: parsedLimit,
        chart,
      },
    };
  }

  function handleRunPreview() {
    const compiled = compileSpec();
    if (!compiled.ok) {
      setBuilderError(compiled.error);
      return;
    }
    setBuilderError(null);
    previewMutation.mutate({ spec: compiled.spec });
  }

  function handleSave(event: FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError("Enter a report name.");
      return;
    }
    if (trimmedName.length > 120) {
      setNameError("Report name must be 120 characters or fewer.");
      return;
    }
    setNameError(null);

    const compiled = compileSpec();
    if (!compiled.ok) {
      setBuilderError(compiled.error);
      return;
    }
    setBuilderError(null);

    if (initialDefinition) {
      updateMutation.mutate({
        definitionId: initialDefinition.definitionId,
        expectedVersion: initialDefinition.version,
        definition: {
          name: trimmedName,
          description: description.trim(),
          visibility,
          spec: compiled.spec,
        },
      });
    } else {
      createMutation.mutate({
        name: trimmedName,
        description: description.trim(),
        visibility,
        spec: compiled.spec,
      });
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumbs
        items={[
          { label: "Reports", href: "/admin/reports" },
          ...(initialDefinition
            ? [
                {
                  label: initialDefinition.name,
                  href: `/admin/reports/custom/${initialDefinition.definitionId}`,
                },
                { label: "Edit" },
              ]
            : [{ label: "New custom report" }]),
        ]}
      />

      <PageHeader
        title={initialDefinition ? "Edit custom report" : "New custom report"}
        description="Build a parameterised report from a whitelisted dataset with typed filters, optional groupings, sorting, and chart output."
        actions={
          <Button
            variant="secondary"
            loading={previewMutation.isPending}
            onClick={handleRunPreview}
          >
            <Play aria-hidden="true" className="size-4" />
            Run preview
          </Button>
        }
      />

      {initialDefinition && !initialDefinition.valid ? (
        <Callout tone="warning" title="Saved definition needs attention">
          One or more fields in this saved report changed since it was created. Review the columns, filters, and groupings below and save an updated version.
        </Callout>
      ) : null}

      {builderError ? (
        <Callout tone="danger" title="Check report configuration">
          {builderError}
        </Callout>
      ) : null}

      <form onSubmit={handleSave} className="flex min-w-0 flex-col gap-6" noValidate>
        <Section
          title="Dataset and query structure"
          description="Choose one whitelisted dataset, then decide whether to list detail rows or group and aggregate metrics."
        >
          <Card className="flex min-w-0 flex-col gap-5">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Dataset" hint={activeDataset.description}>
                <Select
                  value={activeDataset.key}
                  onChange={(e) => handleDatasetChange(e.target.value)}
                  options={datasets.map((d) => ({ value: d.key, label: d.label }))}
                />
              </Field>

              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-sm font-medium text-ink">Query mode</span>
                <div>
                  <SegmentedControl
                    className="max-[320px]:flex max-[320px]:[&_[role=radiogroup]]:flex-col max-[320px]:[&_[role=radio]>span]:whitespace-normal"
                    label="Query mode"
                    value={mode}
                    onValueChange={handleModeChange}
                    options={[
                      { value: "detail", label: "Detail rows" },
                      { value: "grouped", label: "Group & aggregate" },
                    ]}
                  />
                </div>
                <p className="text-xs text-muted">
                  {mode === "detail"
                    ? "Select up to 30 columns to display per record."
                    : "Group up to 3 fields and compute up to 10 count, sum, average, minimum, or maximum metrics."}
                </p>
              </div>
            </div>

            {mode === "detail" ? (
              <fieldset className="flex min-w-0 flex-col gap-3 border-t border-line pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <legend className="text-sm font-semibold text-ink">
                    Columns ({selectedColumns.length} selected)
                  </legend>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setSelectedColumns(activeDataset.fields.slice(0, 30).map((f) => f.key))
                      }
                    >
                      Select all
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const first = activeDataset.fields[0];
                        setSelectedColumns(first ? [first.key] : []);
                      }}
                    >
                      Keep first only
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {activeDataset.fields.map((fld) => {
                    const checked = selectedColumns.includes(fld.key);
                    return (
                      <div
                        key={fld.key}
                        className="flex min-w-0 items-start justify-between gap-2 rounded-[var(--radius-control)] border border-line p-2.5"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) => toggleColumn(fld.key, next)}
                          label={fld.label}
                          description={`Type: ${fld.type}`}
                        />
                        {fld.personal ? <Badge tone="warning">Personal</Badge> : null}
                      </div>
                    );
                  })}
                </div>
              </fieldset>
            ) : null}

            {mode === "grouped" ? (
              <div className="flex min-w-0 flex-col gap-5 border-t border-line pt-4">
                <div className="flex min-w-0 flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-ink">Group by (optional, up to 3)</h3>
                      <p className="text-xs text-muted">
                        Break metrics down by dimension or date bucket. Leave empty to aggregate across the whole dataset.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={groups.length >= 3 || groupableFields.length === 0}
                      onClick={() => {
                        const nextFld =
                          groupableFields.find((f) => !groups.some((g) => g.field === f.key)) ??
                          groupableFields[0];
                        if (!nextFld) return;
                        setGroups((prev) => [
                          ...prev,
                          {
                            id: makeDraftId("grp"),
                            field: nextFld.key,
                            bucket: nextFld.buckets[0] ?? "none",
                          },
                        ]);
                      }}
                    >
                      <Plus aria-hidden="true" className="size-4" />
                      Add group-by
                    </Button>
                  </div>

                  {groups.map((grp, idx) => {
                    const fld = activeDataset.fields.find((f) => f.key === grp.field);
                    const bucketOpts = fld?.buckets ?? [];
                    return (
                      <div
                        key={grp.id}
                        className="grid grid-cols-1 items-end gap-3 rounded-[var(--radius-control)] border border-line bg-surface-sunken p-3 sm:grid-cols-3"
                      >
                        <Field label={`Group field ${idx + 1}`}>
                          <Select
                            value={grp.field}
                            onChange={(e) => {
                              const nextKey = e.target.value;
                              const targetFld = activeDataset.fields.find((f) => f.key === nextKey);
                              setGroups((prev) =>
                                prev.map((item) =>
                                  item.id === grp.id
                                    ? {
                                        ...item,
                                        field: nextKey,
                                        bucket: targetFld?.buckets[0] ?? "none",
                                      }
                                    : item,
                                ),
                              );
                            }}
                            options={groupableFields.map((f) => ({
                              value: f.key,
                              label: f.label,
                            }))}
                          />
                        </Field>

                        {bucketOpts.length > 0 ? (
                          <Field label={`Date bucket ${idx + 1}`}>
                            <Select
                              value={grp.bucket === "none" ? bucketOpts[0]! : grp.bucket}
                              onChange={(e) =>
                                setGroups((prev) =>
                                  prev.map((item) =>
                                    item.id === grp.id
                                      ? { ...item, bucket: e.target.value as Bucket }
                                      : item,
                                  ),
                                )
                              }
                              options={bucketOpts.map((b) => ({
                                value: b,
                                label: BUCKET_LABELS[b],
                              }))}
                            />
                          </Field>
                        ) : (
                          <div className="hidden sm:block" />
                        )}

                        <div className="flex justify-end">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setGroups((prev) => prev.filter((item) => item.id !== grp.id))
                            }
                            aria-label={`Remove group field ${idx + 1}`}
                          >
                            <Trash2 aria-hidden="true" className="size-4" />
                            Remove
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="flex min-w-0 flex-col gap-3 border-t border-line pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-ink">Aggregates (1 to 10)</h3>
                      <p className="text-xs text-muted">
                        Choose summary calculations (row count, sum, average, minimum, or maximum).
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={aggregates.length >= 10}
                      onClick={() =>
                        setAggregates((prev) => [
                          ...prev,
                          { id: makeDraftId("agg"), fn: "count", field: "" },
                        ])
                      }
                    >
                      <Plus aria-hidden="true" className="size-4" />
                      Add aggregate
                    </Button>
                  </div>

                  {aggregates.map((agg, idx) => {
                    const eligibleFields = activeDataset.fields.filter((f) =>
                      f.aggregates.includes(agg.fn),
                    );
                    return (
                      <div
                        key={agg.id}
                        className="grid grid-cols-1 items-end gap-3 rounded-[var(--radius-control)] border border-line bg-surface-sunken p-3 sm:grid-cols-3"
                      >
                        <Field label={`Function ${idx + 1}`}>
                          <Select
                            value={agg.fn}
                            onChange={(e) => {
                              const nextFn = e.target.value as Aggregate;
                              const nextEligible = activeDataset.fields.filter((f) =>
                                f.aggregates.includes(nextFn),
                              );
                              setAggregates((prev) =>
                                prev.map((item) =>
                                  item.id === agg.id
                                    ? {
                                        ...item,
                                        fn: nextFn,
                                        field:
                                          nextFn === "count"
                                            ? ""
                                            : nextEligible[0]?.key ?? "",
                                      }
                                    : item,
                                ),
                              );
                            }}
                            options={AGGREGATES.filter(
                              (fn) =>
                                fn === "count" ||
                                activeDataset.fields.some((f) => f.aggregates.includes(fn)),
                            ).map((fn) => ({
                              value: fn,
                              label: AGGREGATE_LABELS[fn],
                            }))}
                          />
                        </Field>

                        {agg.fn === "count" ? (
                          <div className="text-xs text-muted sm:pb-2.5">
                            Counts matching records in each group.
                          </div>
                        ) : (
                          <Field label={`Metric field ${idx + 1}`}>
                            <Select
                              value={agg.field || eligibleFields[0]?.key || ""}
                              onChange={(e) =>
                                setAggregates((prev) =>
                                  prev.map((item) =>
                                    item.id === agg.id ? { ...item, field: e.target.value } : item,
                                  ),
                                )
                              }
                              options={eligibleFields.map((f) => ({
                                value: f.key,
                                label: f.label,
                              }))}
                            />
                          </Field>
                        )}

                        <div className="flex justify-end">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={aggregates.length <= 1}
                            onClick={() =>
                              setAggregates((prev) =>
                                prev.filter((item) => item.id !== agg.id),
                              )
                            }
                            aria-label={`Remove aggregate ${idx + 1}`}
                          >
                            <Trash2 aria-hidden="true" className="size-4" />
                            Remove
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </Card>
        </Section>

        <Section
          title="Typed filters"
          description="Restrict rows using whitelisted fields and operators (up to 20 filters, combined with AND)."
          actions={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={filters.length >= 20 || filterableFields.length === 0}
              onClick={() => {
                const first = filterableFields[0];
                if (!first) return;
                const firstOp = first.filterOps[0] ?? "eq";
                setFilters((prev) => [
                  ...prev,
                  {
                    id: makeDraftId("flt"),
                    field: first.key,
                    op: firstOp,
                    scalarText: defaultScalarForField(first),
                    rangeStartText: defaultScalarForField(first),
                    rangeEndText: defaultScalarForField(first),
                    listItems: first.enumValues?.[0] ? [first.enumValues[0]] : [],
                  },
                ]);
              }}
            >
              <Plus aria-hidden="true" className="size-4" />
              Add filter
            </Button>
          }
        >
          <Card className="flex min-w-0 flex-col gap-3">
            {filters.length === 0 ? (
              <p className="text-sm text-muted">
                No filters applied — all records in the dataset are included up to the row limit.
              </p>
            ) : (
              filters.map((flt, idx) => {
                const fld =
                  activeDataset.fields.find((f) => f.key === flt.field) ??
                  filterableFields[0];
                const allowedOps = fld?.filterOps.length ? fld.filterOps : (["eq"] as const);
                const inputType =
                  fld?.type === "datetime"
                    ? "date"
                    : fld?.type === "number" || fld?.type === "money" || fld?.type === "duration"
                      ? "number"
                      : "text";
                const valueHint =
                  fld?.type === "money"
                    ? "Integer minor units (for example 2500 = $25.00)"
                    : fld?.type === "duration"
                      ? "Duration in seconds"
                      : undefined;

                return (
                  <div
                    key={flt.id}
                    className="grid grid-cols-1 items-start gap-3 rounded-[var(--radius-control)] border border-line bg-surface-sunken p-3 lg:grid-cols-12"
                  >
                    <div className="lg:col-span-4">
                      <Field label={`Filter field ${idx + 1}`}>
                        <Select
                          value={flt.field}
                          onChange={(e) => {
                            const nextFieldKey = e.target.value;
                            const nextFld = activeDataset.fields.find(
                              (f) => f.key === nextFieldKey,
                            );
                            const nextOp = nextFld?.filterOps[0] ?? "eq";
                            const defVal = defaultScalarForField(nextFld);
                            setFilters((prev) =>
                              prev.map((item) =>
                                item.id === flt.id
                                  ? {
                                      ...item,
                                      field: nextFieldKey,
                                      op: nextOp,
                                      scalarText: defVal,
                                      rangeStartText: defVal,
                                      rangeEndText: defVal,
                                      listItems: nextFld?.enumValues?.[0]
                                        ? [nextFld.enumValues[0]]
                                        : [],
                                    }
                                  : item,
                              ),
                            );
                          }}
                          options={filterableFields.map((f) => ({
                            value: f.key,
                            label: f.personal ? `${f.label} (Personal)` : f.label,
                          }))}
                        />
                      </Field>
                    </div>

                    <div className="lg:col-span-3">
                      <Field label={`Operator ${idx + 1}`}>
                        <Select
                          value={flt.op}
                          onChange={(e) =>
                            setFilters((prev) =>
                              prev.map((item) =>
                                item.id === flt.id
                                  ? { ...item, op: e.target.value as FilterOp }
                                  : item,
                              ),
                            )
                          }
                          options={allowedOps.map((op) => ({
                            value: op,
                            label: FILTER_OP_LABELS[op],
                          }))}
                        />
                      </Field>
                    </div>

                    <div className="lg:col-span-4">
                      {flt.op === "isNull" || flt.op === "isNotNull" ? (
                        <p className="pt-2 text-xs text-muted lg:pt-7">
                          No comparison value required for &ldquo;{FILTER_OP_LABELS[flt.op]}&rdquo;.
                        </p>
                      ) : flt.op === "between" ? (
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <Field label={`Start value ${idx + 1}`} hint={valueHint}>
                            <Input
                              type={inputType}
                              value={flt.rangeStartText}
                              onChange={(e) =>
                                setFilters((prev) =>
                                  prev.map((item) =>
                                    item.id === flt.id
                                      ? { ...item, rangeStartText: e.target.value }
                                      : item,
                                  ),
                                )
                              }
                            />
                          </Field>
                          <Field label={`End value ${idx + 1}`}>
                            <Input
                              type={inputType}
                              value={flt.rangeEndText}
                              onChange={(e) =>
                                setFilters((prev) =>
                                  prev.map((item) =>
                                    item.id === flt.id
                                      ? { ...item, rangeEndText: e.target.value }
                                      : item,
                                  ),
                                )
                              }
                            />
                          </Field>
                        </div>
                      ) : flt.op === "in" ? (
                        <TagInput
                          label={`Values ${idx + 1}`}
                          hint={
                            fld?.enumValues?.length
                              ? `Allowed values: ${fld.enumValues.join(", ")}`
                              : "Press Enter or comma after each value (up to 50)."
                          }
                          suggestions={fld?.enumValues}
                          normalize={(tag) => tag.trim()}
                          value={flt.listItems}
                          onValueChange={(items) =>
                            setFilters((prev) =>
                              prev.map((item) =>
                                item.id === flt.id ? { ...item, listItems: items } : item,
                              ),
                            )
                          }
                          max={50}
                        />
                      ) : fld?.type === "boolean" ? (
                        <Field label={`Value ${idx + 1}`}>
                          <Select
                            value={flt.scalarText === "false" ? "false" : "true"}
                            onChange={(e) =>
                              setFilters((prev) =>
                                prev.map((item) =>
                                  item.id === flt.id
                                    ? { ...item, scalarText: e.target.value }
                                    : item,
                                ),
                              )
                            }
                            options={[
                              { value: "true", label: "Yes (true)" },
                              { value: "false", label: "No (false)" },
                            ]}
                          />
                        </Field>
                      ) : fld?.type === "enum" && fld.enumValues?.length ? (
                        <Field label={`Value ${idx + 1}`}>
                          <Select
                            value={flt.scalarText || fld.enumValues[0]!}
                            onChange={(e) =>
                              setFilters((prev) =>
                                prev.map((item) =>
                                  item.id === flt.id
                                    ? { ...item, scalarText: e.target.value }
                                    : item,
                                ),
                              )
                            }
                            options={fld.enumValues.map((ev) => ({
                              value: ev,
                              label: humanizeCode(ev),
                            }))}
                          />
                        </Field>
                      ) : (
                        <Field label={`Value ${idx + 1}`} hint={valueHint}>
                          <Input
                            type={inputType}
                            maxLength={inputType === "text" ? 200 : undefined}
                            value={flt.scalarText}
                            onChange={(e) =>
                              setFilters((prev) =>
                                prev.map((item) =>
                                  item.id === flt.id
                                    ? { ...item, scalarText: e.target.value }
                                    : item,
                                ),
                              )
                            }
                          />
                        </Field>
                      )}
                    </div>

                    <div className="flex justify-end lg:col-span-1 lg:pt-6">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setFilters((prev) => prev.filter((item) => item.id !== flt.id))
                        }
                        aria-label={`Remove filter ${idx + 1}`}
                      >
                        <Trash2 aria-hidden="true" className="size-4" />
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </Card>
        </Section>

        <Section
          title="Sorting, row limit, and presentation"
          description="Choose how results are ordered, capped, and visualised."
        >
          <Card className="flex min-w-0 flex-col gap-5">
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink">Sort order (up to 3)</h3>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={sorts.length >= 3 || availableSortOptions.length === 0}
                  onClick={() => {
                    const nextOpt =
                      availableSortOptions.find((o) => !sorts.some((s) => s.key === o.value)) ??
                      availableSortOptions[0];
                    if (!nextOpt) return;
                    setSorts((prev) => [
                      ...prev,
                      { id: makeDraftId("srt"), key: nextOpt.value, dir: "desc" },
                    ]);
                  }}
                >
                  <Plus aria-hidden="true" className="size-4" />
                  Add sort
                </Button>
              </div>

              {sorts.map((srt, idx) => (
                <div
                  key={srt.id}
                  className="grid grid-cols-1 items-end gap-3 rounded-[var(--radius-control)] border border-line bg-surface-sunken p-3 sm:grid-cols-3"
                >
                  <Field label={`Sort key ${idx + 1}`}>
                    <Select
                      value={
                        availableSortOptions.some((o) => o.value === srt.key)
                          ? srt.key
                          : availableSortOptions[0]?.value ?? ""
                      }
                      onChange={(e) =>
                        setSorts((prev) =>
                          prev.map((item) =>
                            item.id === srt.id ? { ...item, key: e.target.value } : item,
                          ),
                        )
                      }
                      options={availableSortOptions}
                    />
                  </Field>

                  <Field label={`Direction ${idx + 1}`}>
                    <Select
                      value={srt.dir}
                      onChange={(e) =>
                        setSorts((prev) =>
                          prev.map((item) =>
                            item.id === srt.id
                              ? { ...item, dir: e.target.value as "asc" | "desc" }
                              : item,
                          ),
                        )
                      }
                      options={[
                        { value: "desc", label: "Descending (highest / newest first)" },
                        { value: "asc", label: "Ascending (lowest / oldest first)" },
                      ]}
                    />
                  </Field>

                  <div className="flex justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setSorts((prev) => prev.filter((item) => item.id !== srt.id))
                      }
                      aria-label={`Remove sort ${idx + 1}`}
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-4 border-t border-line pt-4 sm:grid-cols-2">
              <Field
                label="Row limit"
                hint={`Up to ${limits.screenRows.toLocaleString()} rows display on screen; saved CSV exports include up to ${limits.csvRows.toLocaleString()} rows.`}
                error={limitError ?? undefined}
              >
                <Input
                  type="number"
                  min={1}
                  max={limits.csvRows}
                  value={limitText}
                  onChange={(e) => {
                    setLimitText(e.target.value);
                    if (limitError) setLimitError(null);
                  }}
                />
              </Field>

              <Field
                label="Default visualisation"
                hint="Every chart also includes a full accessible data table toggle and text summary."
              >
                <Select
                  value={chart}
                  onChange={(e) => setChart(e.target.value as ChartType)}
                  options={CHART_TYPES.map((ct) => ({
                    value: ct,
                    label: CHART_TYPE_LABELS[ct],
                  }))}
                />
              </Field>
            </div>

            <div className="flex justify-end border-t border-line pt-3">
              <Button
                type="button"
                variant="secondary"
                loading={previewMutation.isPending}
                onClick={handleRunPreview}
              >
                <Play aria-hidden="true" className="size-4" />
                Run preview
              </Button>
            </div>
          </Card>
        </Section>

        {previewResult ? (
          <ReportResultSection
            title={name.trim() ? `Preview: ${name.trim()}` : "Report preview"}
            headingLevel={2}
            chart={previewResult.chart}
            table={previewResult}
            screenRowCap={limits.screenRows}
          />
        ) : null}

        <Section
          title="Save custom report"
          description="Save this definition to run on demand or export audited CSV snapshots."
        >
          <Card className="flex min-w-0 flex-col gap-4">
            <Field label="Report name" required error={nameError ?? undefined}>
              <Input
                value={name}
                maxLength={120}
                placeholder="For example: High-priority support backlog by category"
                onChange={(e) => {
                  setName(e.target.value);
                  if (nameError) setNameError(null);
                }}
              />
            </Field>

            <Field
              label="Description"
              hint="Optional context shown on the Reports overview (up to 500 characters)."
            >
              <Textarea
                rows={2}
                maxLength={500}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>

            <RadioGroup
              legend="Visibility"
              variant="cards"
              value={visibility}
              onValueChange={(val) => setVisibility(val as ReportVisibility)}
              options={[
                {
                  value: "private",
                  label: "Private",
                  description: "Visible and runnable only by your administrator account.",
                },
                {
                  value: "shared",
                  label: "Shared with administrators",
                  description:
                    "Visible, runnable, and duplicable by all administrators; only you can edit or delete.",
                },
              ]}
            />

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
              <Button type="button" variant="ghost" asChild>
                <Link
                  href={
                    initialDefinition
                      ? `/admin/reports/custom/${initialDefinition.definitionId}`
                      : "/admin/reports"
                  }
                >
                  Cancel
                </Link>
              </Button>
              <Button type="submit" loading={isSaving}>
                <Save aria-hidden="true" className="size-4" />
                {initialDefinition ? "Save changes" : "Save custom report"}
              </Button>
            </div>
          </Card>
        </Section>
      </form>
    </div>
  );
}

export default function CustomReportBuilderPage() {
  const params = useParams<{ definitionId?: string }>();
  const editingId = params.definitionId ?? null;

  const reports = useReportsProcedures();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [, setLocation] = useLocation();
  const [dupError, setDupError] = useState<string | null>(null);

  const catalogueQuery = useQuery(reports.catalogue.queryOptions());
  const definitionQuery = useQuery(
    reports.custom.get.queryOptions(
      { definitionId: editingId ?? "" },
      { enabled: Boolean(editingId), retry: false },
    ),
  );

  const duplicateMutation = useMutation(
    reports.custom.duplicate.mutationOptions({
      onSuccess: (copy) => {
        void queryClient.invalidateQueries();
        toast.show({
          tone: "success",
          title: "Duplicated to your reports",
          description: `Editing "${copy.name}".`,
        });
        setLocation(`/admin/reports/custom/${copy.definitionId}/edit`);
      },
      onError: (err) => {
        setDupError(describeReportError(err).message);
      },
    }),
  );

  if (catalogueQuery.isPending || (editingId && definitionQuery.isPending)) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <Breadcrumbs
          items={[
            { label: "Reports", href: "/admin/reports" },
            { label: editingId ? "Edit custom report" : "New custom report" },
          ]}
        />
        <PageHeader title={editingId ? "Edit custom report" : "New custom report"} />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (catalogueQuery.error) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <Breadcrumbs
          items={[
            { label: "Reports", href: "/admin/reports" },
            { label: editingId ? "Edit custom report" : "New custom report" },
          ]}
        />
        <PageHeader title={editingId ? "Edit custom report" : "New custom report"} />
        <ErrorState error={catalogueQuery.error} onRetry={() => void catalogueQuery.refetch()} />
      </div>
    );
  }

  if (editingId && definitionQuery.error) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <Breadcrumbs
          items={[
            { label: "Reports", href: "/admin/reports" },
            { label: "Edit custom report" },
          ]}
        />
        <PageHeader title="Edit custom report" />
        <ErrorState error={definitionQuery.error} onRetry={() => void definitionQuery.refetch()} />
      </div>
    );
  }

  if (editingId && definitionQuery.data && !definitionQuery.data.ownedByMe) {
    const sharedDef = definitionQuery.data;
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <Breadcrumbs
          items={[
            { label: "Reports", href: "/admin/reports" },
            { label: sharedDef.name, href: `/admin/reports/custom/${sharedDef.definitionId}` },
            { label: "Edit" },
          ]}
        />
        <PageHeader
          title={sharedDef.name}
          description="Shared custom reports can only be edited or deleted by their owner."
        />
        {dupError ? (
          <Callout tone="danger" title="Could not duplicate report">
            {dupError}
          </Callout>
        ) : null}
        <Callout
          tone="info"
          title="Read-only shared definition"
          actions={
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                loading={duplicateMutation.isPending}
                onClick={() => duplicateMutation.mutate({ definitionId: sharedDef.definitionId })}
              >
                <Copy aria-hidden="true" className="size-4" />
                Duplicate to edit
              </Button>
              <Button variant="secondary" size="sm" asChild>
                <Link href={`/admin/reports/custom/${sharedDef.definitionId}`}>
                  Run shared report
                </Link>
              </Button>
            </div>
          }
        >
          Duplicate this report to create your own editable copy while keeping the shared version intact.
        </Callout>
      </div>
    );
  }

  const datasets = catalogueQuery.data?.datasets ?? [];
  const limits = catalogueQuery.data?.limits ?? REPORT_LIMITS;

  if (datasets.length === 0) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <Breadcrumbs
          items={[
            { label: "Reports", href: "/admin/reports" },
            { label: "New custom report" },
          ]}
        />
        <PageHeader title="New custom report" />
        <EmptyState
          title="No datasets available"
          description="Custom report datasets require administrator report management access."
          action={
            <Button asChild>
              <Link href="/admin/reports">Back to Reports</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const initialDefinition = editingId ? (definitionQuery.data ?? null) : null;
  const formKey = initialDefinition
    ? `${initialDefinition.definitionId}:${initialDefinition.version}`
    : "new";

  return (
    <CustomReportBuilderForm
      key={formKey}
      datasets={datasets}
      limits={limits}
      initialDefinition={initialDefinition}
    />
  );
}
