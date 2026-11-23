/**
 * Accessible SVG charts (`bar`, `line`, `pie`) and table-backed report panels for Package I (`reports`).
 * Uses `@/ui`'s `ChartFrame` + `useChartIds` + semantic chart tokens (`fill-chart-1..6`, `stroke-chart-1..6`).
 * Colour is never the sole cue: multi-series bars and donut slices apply `ids.patternFill(2..6)`,
 * line series combine distinct dash patterns and point markers, and every chart has a text summary + DataTable.
 */
import { useId, type ReactNode } from "react";
import {
  Callout,
  ChartFrame,
  DataTable,
  EmptyState,
  ErrorState,
  Skeleton,
  useChartIds,
  type ChartLegendItem,
  type ChartSeries,
  type Column,
} from "@/ui";
import { buildTableSummary, formatCellPlain, renderCellNode } from "./format";
import type { Cell, ChartType, ColumnView, TableResult } from "./types";

const SERIES_NUMBERS: readonly ChartSeries[] = [1, 2, 3, 4, 5, 6];

const SERIES_STROKE: Record<ChartSeries, string> = {
  1: "stroke-chart-1",
  2: "stroke-chart-2",
  3: "stroke-chart-3",
  4: "stroke-chart-4",
  5: "stroke-chart-5",
  6: "stroke-chart-6",
};

const SERIES_FILL: Record<ChartSeries, string> = {
  1: "fill-chart-1",
  2: "fill-chart-2",
  3: "fill-chart-3",
  4: "fill-chart-4",
  5: "fill-chart-5",
  6: "fill-chart-6",
};

const SERIES_DASH: Record<ChartSeries, string | undefined> = {
  1: undefined,
  2: "7 4",
  3: "2 4",
  4: "9 4 2 4",
  5: "5 5",
  6: "12 3 2 3",
};

function isPlottableType(type: ColumnView["type"]): boolean {
  return type === "number" || type === "money" || type === "duration";
}

interface ExtractedPlotData {
  labelColIndex: number;
  labelCol: ColumnView;
  metricIndices: number[];
  points: {
    label: string;
    shortLabel: string;
    rawRow: readonly Cell[];
    values: number[];
    formattedValues: string[];
  }[];
}

function truncateSvgLabel(raw: string, max = 14): string {
  return raw.length <= max ? raw : `${raw.slice(0, max - 1)}…`;
}

function extractPlotData(table: TableResult, maxPoints = 24): ExtractedPlotData | null {
  if (table.columns.length === 0 || table.rows.length === 0) return null;
  const metricIndices: number[] = [];
  for (let i = 0; i < table.columns.length && metricIndices.length < 6; i += 1) {
    if (isPlottableType(table.columns[i]!.type)) {
      metricIndices.push(i);
    }
  }
  if (metricIndices.length === 0) return null;

  let labelColIndex = table.columns.findIndex((_, idx) => !metricIndices.includes(idx));
  if (labelColIndex < 0) {
    labelColIndex = 0;
  }
  const labelCol = table.columns[labelColIndex]!;
  const sliceRows = table.rows.slice(0, maxPoints);

  const points = sliceRows.map((row, rowIdx) => {
    const formattedLabel =
      labelColIndex >= 0
        ? formatCellPlain(row[labelColIndex] ?? null, labelCol, row, table.columns)
        : `Row ${rowIdx + 1}`;
    const values = metricIndices.map((colIdx) => {
      const n = Number(row[colIdx] ?? 0);
      return Number.isFinite(n) ? n : 0;
    });
    const formattedValues = metricIndices.map((colIdx) =>
      formatCellPlain(row[colIdx] ?? 0, table.columns[colIdx]!, row, table.columns),
    );
    return {
      label: formattedLabel,
      shortLabel: truncateSvgLabel(formattedLabel, sliceRows.length > 10 ? 10 : 16),
      rawRow: row,
      values,
      formattedValues,
    };
  });

  return {
    labelColIndex,
    labelCol,
    metricIndices,
    points,
  };
}

function niceAxisBounds(values: readonly number[]): { min: number; max: number; ticks: number[] } {
  let minVal = 0;
  let maxVal = 0;
  for (const v of values) {
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }
  if (maxVal === 0 && minVal === 0) {
    return { min: 0, max: 4, ticks: [0, 1, 2, 3, 4] };
  }
  const rawSpan = Math.max(1e-6, maxVal - minVal);
  const roughStep = rawSpan / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const residual = roughStep / mag;
  const niceStep =
    residual <= 1 ? mag : residual <= 2 ? 2 * mag : residual <= 5 ? 5 * mag : 10 * mag;
  const niceMin = minVal < 0 ? Math.floor(minVal / niceStep) * niceStep : 0;
  const niceMax = Math.max(niceMin + niceStep, Math.ceil(maxVal / niceStep) * niceStep);
  const ticks: number[] = [];
  for (let t = niceMin; t <= niceMax + niceStep * 0.001 && ticks.length < 7; t += niceStep) {
    ticks.push(Number(t.toFixed(6)));
  }
  return { min: niceMin, max: niceMax, ticks };
}

function formatAxisTick(val: number, col: ColumnView, sampleRow: readonly Cell[], columns: readonly ColumnView[]): string {
  if (col.type === "money" || col.type === "duration" || col.type === "number") {
    return formatCellPlain(val, col, sampleRow, columns);
  }
  return String(val);
}

function LineMarker({
  series,
  cx,
  cy,
}: {
  series: ChartSeries;
  cx: number;
  cy: number;
}) {
  const strokeCls = SERIES_STROKE[series];
  const fillCls = SERIES_FILL[series];
  switch (series) {
    case 1:
      return <circle cx={cx} cy={cy} r={4} className={`${fillCls} stroke-surface`} strokeWidth={1.5} />;
    case 2:
      return (
        <rect
          x={cx - 3.5}
          y={cy - 3.5}
          width={7}
          height={7}
          className={`${fillCls} stroke-surface`}
          strokeWidth={1.5}
        />
      );
    case 3:
      return (
        <polygon
          points={`${cx},${cy - 5} ${cx + 4.5},${cy} ${cx},${cy + 5} ${cx - 4.5},${cy}`}
          className={`${fillCls} stroke-surface`}
          strokeWidth={1.5}
        />
      );
    case 4:
      return (
        <polygon
          points={`${cx},${cy - 5} ${cx + 4.5},${cy + 4} ${cx - 4.5},${cy + 4}`}
          className={`${fillCls} stroke-surface`}
          strokeWidth={1.5}
        />
      );
    case 5:
      return (
        <polygon
          points={`${cx - 4.5},${cy - 4} ${cx + 4.5},${cy - 4} ${cx},${cy + 5}`}
          className={`${fillCls} stroke-surface`}
          strokeWidth={1.5}
        />
      );
    case 6:
    default:
      return (
        <g className={strokeCls} strokeWidth={2}>
          <line x1={cx - 4} y1={cy - 4} x2={cx + 4} y2={cy + 4} />
          <line x1={cx - 4} y1={cy + 4} x2={cx + 4} y2={cy - 4} />
        </g>
      );
  }
}

function SvgBarChart({
  plot,
  columns,
}: {
  plot: ExtractedPlotData;
  columns: readonly ColumnView[];
}) {
  const ids = useChartIds();
  const width = 640;
  const height = 272;
  const padLeft = 86;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 52;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const allValues = plot.points.flatMap((p) => p.values);
  const { min, max, ticks } = niceAxisBounds(allValues);
  const span = Math.max(1e-6, max - min);
  const zeroY = padTop + plotH - ((0 - min) / span) * plotH;
  const primaryCol = columns[plot.metricIndices[0]!]!;
  const sampleRow = plot.points[0]?.rawRow ?? [];

  const groupCount = plot.points.length;
  const seriesCount = plot.metricIndices.length;
  const slotW = plotW / Math.max(1, groupCount);
  const groupW = Math.min(72, slotW * 0.76);
  const barW = Math.max(4, (groupW - (seriesCount - 1) * 3) / seriesCount);
  const showValueLabels = groupCount * seriesCount <= 12;
  const labelStride = groupCount > 12 ? Math.ceil(groupCount / 8) : 1;

  return (
    <svg role="img" aria-labelledby={ids.labelledBy} viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
      {ticks.map((tick) => {
        const y = padTop + plotH - ((tick - min) / span) * plotH;
        return (
          <g key={tick}>
            <line
              x1={padLeft}
              y1={y}
              x2={width - padRight}
              y2={y}
              className="stroke-line"
              strokeDasharray={tick === 0 ? undefined : "3 3"}
              strokeWidth={1}
            />
            <text
              x={padLeft - 8}
              y={y + 4}
              textAnchor="end"
              className="fill-muted text-[11px]"
            >
              {truncateSvgLabel(formatAxisTick(tick, primaryCol, sampleRow, columns), 12)}
            </text>
          </g>
        );
      })}

      {plot.points.map((pt, groupIdx) => {
        const slotCenter = padLeft + slotW * groupIdx + slotW / 2;
        const groupStart = slotCenter - (seriesCount * barW + (seriesCount - 1) * 3) / 2;
        return (
          <g key={`${groupIdx}-${pt.label}`}>
            {pt.values.map((val, sIdx) => {
              const series = SERIES_NUMBERS[sIdx % SERIES_NUMBERS.length]!;
              const valY = padTop + plotH - ((val - min) / span) * plotH;
              const topY = Math.min(valY, zeroY);
              const barH = Math.max(2, Math.abs(zeroY - valY));
              const x = groupStart + sIdx * (barW + 3);
              const usePattern = seriesCount > 1 && series > 1;
              return (
                <g key={series}>
                  <rect
                    x={x}
                    y={topY}
                    width={barW}
                    height={barH}
                    rx={2}
                    className={usePattern ? "stroke-surface" : `${SERIES_FILL[series]} stroke-surface`}
                    fill={usePattern ? ids.patternFill(series) : undefined}
                    strokeWidth={1}
                  >
                    <title>{`${pt.label} — ${columns[plot.metricIndices[sIdx]!]!.label}: ${pt.formattedValues[sIdx]}`}</title>
                  </rect>
                  {showValueLabels ? (
                    <text
                      x={x + barW / 2}
                      y={Math.max(12, topY - 5)}
                      textAnchor="middle"
                      className="fill-ink text-[10px] font-medium"
                    >
                      {truncateSvgLabel(pt.formattedValues[sIdx] ?? "", 10)}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {groupIdx % labelStride === 0 ? (
              <text
                x={slotCenter}
                y={height - padBottom + 18}
                textAnchor="middle"
                className="fill-muted text-[11px]"
              >
                {pt.shortLabel}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function SvgLineChart({
  plot,
  columns,
}: {
  plot: ExtractedPlotData;
  columns: readonly ColumnView[];
}) {
  const ids = useChartIds();
  const width = 640;
  const height = 272;
  const padLeft = 86;
  const padRight = 24;
  const padTop = 20;
  const padBottom = 52;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const allValues = plot.points.flatMap((p) => p.values);
  const { min, max, ticks } = niceAxisBounds(allValues);
  const span = Math.max(1e-6, max - min);
  const primaryCol = columns[plot.metricIndices[0]!]!;
  const sampleRow = plot.points[0]?.rawRow ?? [];

  const count = plot.points.length;
  const xForIndex = (idx: number) =>
    count <= 1 ? padLeft + plotW / 2 : padLeft + (idx / (count - 1)) * plotW;
  const yForVal = (val: number) => padTop + plotH - ((val - min) / span) * plotH;
  const labelStride = count > 10 ? Math.ceil(count / 7) : 1;

  return (
    <svg role="img" aria-labelledby={ids.labelledBy} viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
      {ticks.map((tick) => {
        const y = yForVal(tick);
        return (
          <g key={tick}>
            <line
              x1={padLeft}
              y1={y}
              x2={width - padRight}
              y2={y}
              className="stroke-line"
              strokeDasharray={tick === 0 ? undefined : "3 3"}
              strokeWidth={1}
            />
            <text x={padLeft - 8} y={y + 4} textAnchor="end" className="fill-muted text-[11px]">
              {truncateSvgLabel(formatAxisTick(tick, primaryCol, sampleRow, columns), 12)}
            </text>
          </g>
        );
      })}

      {plot.metricIndices.map((colIdx, sIdx) => {
        const series = SERIES_NUMBERS[sIdx % SERIES_NUMBERS.length]!;
        const coords = plot.points.map((pt, pIdx) => ({
          x: xForIndex(pIdx),
          y: yForVal(pt.values[sIdx] ?? 0),
          label: pt.label,
          formatted: pt.formattedValues[sIdx] ?? "0",
        }));
        const polyPoints = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
        return (
          <g key={colIdx}>
            {coords.length > 1 ? (
              <polyline
                fill="none"
                points={polyPoints}
                className={SERIES_STROKE[series]}
                strokeWidth={2.5}
                strokeDasharray={SERIES_DASH[series]}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}
            {coords.map((c, cIdx) => (
              <g key={`${cIdx}-${c.label}`}>
                <LineMarker series={series} cx={c.x} cy={c.y} />
                <title>{`${c.label} — ${columns[colIdx]!.label}: ${c.formatted}`}</title>
              </g>
            ))}
          </g>
        );
      })}

      {plot.points.map((pt, idx) =>
        idx % labelStride === 0 || idx === count - 1 ? (
          <text
            key={`${idx}-${pt.label}`}
            x={xForIndex(idx)}
            y={height - padBottom + 18}
            textAnchor="middle"
            className="fill-muted text-[11px]"
          >
            {pt.shortLabel}
          </text>
        ) : null,
      )}
    </svg>
  );
}

interface PieSlice {
  series: ChartSeries;
  label: string;
  value: number;
  formattedValue: string;
  sharePct: string;
}

function buildPieSlices(plot: ExtractedPlotData, columns: readonly ColumnView[]): {
  slices: PieSlice[];
  total: number;
  formattedTotal: string;
} {
  const metricColIdx = plot.metricIndices[0]!;
  const metricCol = columns[metricColIdx]!;
  const sampleRow = plot.points[0]?.rawRow ?? [];
  const positive = plot.points
    .map((pt) => ({
      label: pt.label,
      value: Math.max(0, pt.values[0] ?? 0),
      rawRow: pt.rawRow,
    }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value);

  const total = positive.reduce((acc, item) => acc + item.value, 0);
  if (total <= 0) {
    return {
      slices: [],
      total: 0,
      formattedTotal: formatCellPlain(0, metricCol, sampleRow, columns),
    };
  }

  const capped: { label: string; value: number; rawRow: readonly Cell[] }[] =
    positive.length <= 6
      ? positive
      : [
          ...positive.slice(0, 5),
          {
            label: "Other",
            value: positive.slice(5).reduce((acc, item) => acc + item.value, 0),
            rawRow: sampleRow,
          },
        ];

  const slices: PieSlice[] = capped.map((item, idx) => {
    const series = SERIES_NUMBERS[idx % SERIES_NUMBERS.length]!;
    const pct = ((item.value / total) * 100).toFixed(1);
    return {
      series,
      label: item.label,
      value: item.value,
      formattedValue: formatCellPlain(item.value, metricCol, item.rawRow, columns),
      sharePct: `${pct}%`,
    };
  });

  return {
    slices,
    total,
    formattedTotal: formatCellPlain(total, metricCol, sampleRow, columns),
  };
}

function donutArcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number,
): string {
  const fullCircle = endAngle - startAngle >= Math.PI * 2 - 0.0001;
  if (fullCircle) {
    const mid = startAngle + Math.PI;
    return [
      donutArcPath(cx, cy, rOuter, rInner, startAngle, mid),
      donutArcPath(cx, cy, rOuter, rInner, mid, startAngle + Math.PI * 2 - 0.0002),
    ].join(" ");
  }
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  const x1 = cx + rOuter * Math.cos(startAngle);
  const y1 = cy + rOuter * Math.sin(startAngle);
  const x2 = cx + rOuter * Math.cos(endAngle);
  const y2 = cy + rOuter * Math.sin(endAngle);
  const x3 = cx + rInner * Math.cos(endAngle);
  const y3 = cy + rInner * Math.sin(endAngle);
  const x4 = cx + rInner * Math.cos(startAngle);
  const y4 = cy + rInner * Math.sin(startAngle);

  return [
    `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
    `L ${x3.toFixed(2)} ${y3.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${x4.toFixed(2)} ${y4.toFixed(2)}`,
    "Z",
  ].join(" ");
}

function SvgPieChart({
  slices,
  formattedTotal,
  metricLabel,
}: {
  slices: readonly PieSlice[];
  formattedTotal: string;
  metricLabel: string;
}) {
  const ids = useChartIds();
  const width = 640;
  const height = 244;
  const cx = 148;
  const cy = 122;
  const rOuter = 92;
  const rInner = 54;
  const total = slices.reduce((acc, s) => acc + s.value, 0);

  let angle = -Math.PI / 2;

  return (
    <svg role="img" aria-labelledby={ids.labelledBy} viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
      {total <= 0 ? (
        <g>
          <circle cx={cx} cy={cy} r={rOuter} className="fill-none stroke-line" strokeWidth={18} />
          <text x={cx} y={cy + 4} textAnchor="middle" className="fill-muted text-xs">
            0 total
          </text>
        </g>
      ) : (
        slices.map((slice) => {
          const sweep = (slice.value / total) * Math.PI * 2;
          const nextAngle = angle + sweep;
          const d = donutArcPath(cx, cy, rOuter, rInner, angle, nextAngle);
          angle = nextAngle;
          const usePattern = slice.series > 1;
          return (
            <path
              key={`${slice.series}-${slice.label}`}
              d={d}
              className={usePattern ? "stroke-surface" : `${SERIES_FILL[slice.series]} stroke-surface`}
              fill={usePattern ? ids.patternFill(slice.series) : undefined}
              strokeWidth={2}
            >
              <title>{`${slice.label}: ${slice.formattedValue} (${slice.sharePct})`}</title>
            </path>
          );
        })
      )}

      <text x={cx} y={cy - 4} textAnchor="middle" className="fill-muted text-[11px]">
        {truncateSvgLabel(metricLabel, 14)}
      </text>
      <text x={cx} y={cy + 14} textAnchor="middle" className="fill-ink text-sm font-semibold">
        {truncateSvgLabel(formattedTotal, 14)}
      </text>

      {/* Right-hand proportional horizontal share bars so rank & share are visible directly inside the graphic */}
      {slices.map((slice, idx) => {
        const rowY = 34 + idx * 34;
        const barMaxW = 180;
        const barW = total > 0 ? Math.max(4, (slice.value / total) * barMaxW) : 0;
        const usePattern = slice.series > 1;
        return (
          <g key={`bar-${slice.series}-${slice.label}`}>
            <text x={282} y={rowY + 11} className="fill-ink text-[12px] font-medium">
              {truncateSvgLabel(slice.label, 18)}
            </text>
            <rect x={422} y={rowY} width={barMaxW} height={14} rx={3} className="fill-none stroke-line" />
            <rect
              x={422}
              y={rowY}
              width={barW}
              height={14}
              rx={3}
              className={usePattern ? "stroke-surface" : `${SERIES_FILL[slice.series]} stroke-surface`}
              fill={usePattern ? ids.patternFill(slice.series) : undefined}
            />
            <text x={610} y={rowY + 11} textAnchor="end" className="fill-muted text-[11px]">
              {slice.sharePct}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

interface IndexedRow {
  idx: number;
  cells: readonly Cell[];
}

export interface ReportResultSectionProps {
  title: string;
  headingLevel?: 2 | 3;
  description?: ReactNode;
  chart: ChartType;
  summary?: string;
  table: TableResult;
  actions?: ReactNode;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  screenRowCap?: number;
}

export function ReportResultSection({
  title,
  headingLevel = 2,
  description,
  chart,
  summary,
  table,
  actions,
  loading,
  error,
  onRetry,
  screenRowCap = 5_000,
}: ReportResultSectionProps) {
  const sectionHeadingId = useId();
  const resolvedSummary = summary && summary.trim().length > 0 ? summary : buildTableSummary(title, table);

  const indexedRows: IndexedRow[] = table.rows.map((cells, idx) => ({ idx, cells }));
  const dataColumns: Column<IndexedRow>[] = table.columns.map((col, colIdx) => {
    const numericAlign =
      col.type === "number" || col.type === "money" || col.type === "duration";
    return {
      key: col.key || `col_${colIdx}`,
      header: col.label,
      primary: colIdx === 0,
      align: numericAlign ? "end" : "start",
      cell: (row) => renderCellNode(row.cells[colIdx] ?? null, col, row.cells, table.columns),
    };
  });

  const truncationBanner = table.truncated ? (
    <Callout tone="warning" title="Screen row limit reached">
      Showing the first {screenRowCap.toLocaleString()} rows on screen. Narrow the filters or export CSV for up to 100,000 rows.
    </Callout>
  ) : null;

  const dataTableNode = (
    <div className="flex flex-col gap-3">
      {truncationBanner}
      <DataTable
        caption={`${title} data table`}
        columns={dataColumns}
        rows={indexedRows}
        rowKey={(row) => String(row.idx)}
        empty={<EmptyState title="No matching rows" size="sm" headingLevel={3} />}
      />
    </div>
  );

  const plot = chart === "table" ? null : extractPlotData(table);

  // Table-only panels (or custom specs without any numeric metric column) render directly as an accessible section.
  if (chart === "table" || (!loading && !error && table.rows.length > 0 && !plot)) {
    const Heading = headingLevel === 3 ? "h3" : "h2";
    return (
      <section
        aria-labelledby={sectionHeadingId}
        className="flex min-w-0 flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-[var(--shadow-card)] sm:p-5 rp-forced-border"
      >
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Heading id={sectionHeadingId} className="text-base font-semibold break-words text-ink">
              {title}
            </Heading>
            {description ? <div className="mt-0.5 text-sm break-words text-muted">{description}</div> : null}
          </div>
          {actions ? <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div> : null}
        </div>

        {error ? (
          <ErrorState error={error} onRetry={onRetry} />
        ) : loading ? (
          <div role="status" aria-label={`Loading ${title}`} className="flex flex-col gap-2">
            <Skeleton className="h-44" />
            <span className="sr-only">Loading {title}</span>
          </div>
        ) : table.rows.length === 0 ? (
          <EmptyState title="No data for this selection" size="sm" headingLevel={3} />
        ) : (
          <>
            <p className="text-sm break-words text-body">{resolvedSummary}</p>
            {dataTableNode}
          </>
        )}
      </section>
    );
  }

  let legend: ChartLegendItem[] = [];
  let svgNode: ReactNode = null;

  if (plot) {
    if (chart === "pie") {
      const pie = buildPieSlices(plot, table.columns);
      const metricCol = table.columns[plot.metricIndices[0]!]!;
      legend = pie.slices.map((s) => ({
        series: s.series,
        label: `${s.label}: ${s.formattedValue} (${s.sharePct})`,
        pattern: s.series > 1,
      }));
      svgNode = (
        <SvgPieChart
          slices={pie.slices}
          formattedTotal={pie.formattedTotal}
          metricLabel={metricCol.label}
        />
      );
    } else if (chart === "line") {
      legend = plot.metricIndices.map((colIdx, sIdx) => {
        const series = SERIES_NUMBERS[sIdx % SERIES_NUMBERS.length]!;
        return {
          series,
          label: table.columns[colIdx]!.label,
          pattern: false,
        };
      });
      svgNode = <SvgLineChart plot={plot} columns={table.columns} />;
    } else {
      const multi = plot.metricIndices.length > 1;
      legend = plot.metricIndices.map((colIdx, sIdx) => {
        const series = SERIES_NUMBERS[sIdx % SERIES_NUMBERS.length]!;
        return {
          series,
          label: table.columns[colIdx]!.label,
          pattern: multi && series > 1,
        };
      });
      svgNode = <SvgBarChart plot={plot} columns={table.columns} />;
    }
  }

  return (
    <ChartFrame
      title={title}
      headingLevel={headingLevel}
      description={description}
      summary={resolvedSummary}
      legend={legend}
      actions={actions}
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!loading && !error && table.rows.length === 0 ? true : undefined}
      table={
        <div className="flex flex-col gap-3">
          {truncationBanner}
          <DataTable
            caption={`${title} data table`}
            columns={dataColumns}
            rows={indexedRows}
            rowKey={(row) => String(row.idx)}
          />
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {truncationBanner}
        {svgNode}
      </div>
    </ChartFrame>
  );
}
