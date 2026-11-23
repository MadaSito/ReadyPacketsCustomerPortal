/**
 * Chart frame (increment 06, reports). Gives every chart a heading, a visible text summary, a Chart | Table
 * switch (the table is the complete data alternative), a text legend with swatches, and loading / empty /
 * error states. The chart itself is the caller's SVG: `<svg role="img" aria-labelledby={ids.labelledBy}>`,
 * viewBox + `w-full`, fills and strokes from the chart tokens (`fill-chart-1..6`, `stroke-line`, `fill-muted`)
 * and `ids.patternFill(n)` where colour must not be the only cue (stacked bars, areas).
 */
import { BarChart3, Table2 } from "lucide-react";
import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { cn } from "./cn";
import { EmptyState, ErrorState, Skeleton } from "./Feedback";
import { SegmentedControl } from "./SegmentedControl";

export type ChartSeries = 1 | 2 | 3 | 4 | 5 | 6;

export interface ChartLegendItem {
  label: string;
  series: ChartSeries;
  /** Show the series pattern in the swatch (use when the chart uses patternFill for this series). */
  pattern?: boolean;
}

export interface ChartIds {
  titleId: string;
  summaryId: string;
  /** For the chart <svg>: title + summary. */
  labelledBy: string;
  /** `url(#…)` of the frame's pattern for a series (pattern drawn in the series colour). */
  patternFill: (series: ChartSeries) => string;
}

const ChartIdsContext = createContext<ChartIds | null>(null);

/** Ids of the nearest ChartFrame (heading, summary, patterns). Outside a frame, unique fallbacks. */
export function useChartIds(): ChartIds {
  const ctx = useContext(ChartIdsContext);
  const fallback = useId().replace(/:/g, "");
  return ctx ?? makeIds(`rpchart${fallback}`);
}

function makeIds(prefix: string): ChartIds {
  return {
    titleId: `${prefix}-title`,
    summaryId: `${prefix}-summary`,
    labelledBy: `${prefix}-title ${prefix}-summary`,
    patternFill: (series) => `url(#${prefix}-pattern-${series})`,
  };
}

const SERIES_FILL: Record<ChartSeries, string> = { 1: "fill-chart-1", 2: "fill-chart-2", 3: "fill-chart-3", 4: "fill-chart-4", 5: "fill-chart-5", 6: "fill-chart-6" };
/** Overlay drawn on the series colour; series 1 stays solid. */
const PATTERN_PATH: Record<ChartSeries, string | null> = {
  1: null,
  2: "M-2 2l4-4M0 8l8-8M6 10l4-4",
  3: "M2 2h.01M6 6h.01",
  4: "M0 2h8M0 6h8",
  5: "M0 0l8 8M8 0l-8 8",
  6: "M2 0v8M6 0v8",
};

/** SVG <defs> with the six series patterns. ChartFrame renders one already; use this only outside a frame. */
export function ChartPatterns({ prefix }: { prefix?: string }) {
  const ids = useChartIds();
  const fill = prefix ? makeIds(prefix).patternFill : ids.patternFill;
  return (
    <defs>
      {([1, 2, 3, 4, 5, 6] as const).map((n) => {
        const id = fill(n).slice(5, -1);
        const path = PATTERN_PATH[n];
        return (
          <pattern key={n} id={id} patternUnits="userSpaceOnUse" width="8" height="8">
            <rect width="8" height="8" className={SERIES_FILL[n]} />
            {path ? <path d={path} className="stroke-surface" strokeWidth={n === 3 ? 2.5 : 1.5} strokeLinecap="round" fill="none" /> : null}
          </pattern>
        );
      })}
    </defs>
  );
}

export interface ChartFrameProps {
  title: string;
  headingLevel?: 2 | 3;
  description?: ReactNode;
  /** Plain-language summary of what the chart shows (always visible; also names the SVG). */
  summary: string;
  /** Complete data alternative, normally a DataTable with the same figures. */
  table: ReactNode;
  legend?: readonly ChartLegendItem[];
  actions?: ReactNode;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** No data: `true` for the standard message, or your own node; shown instead of chart and table. */
  empty?: ReactNode | true;
  defaultView?: "chart" | "table";
  className?: string;
  /** The chart SVG. */
  children: ReactNode;
}

export function ChartFrame({ title, headingLevel = 2, description, summary, table, legend, actions, loading, error, onRetry, empty, defaultView = "chart", className, children }: ChartFrameProps) {
  const prefix = `rpchart${useId().replace(/:/g, "")}`;
  const ids = makeIds(prefix);
  const [view, setView] = useState<"chart" | "table">(defaultView);
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const showData = !loading && !error && !empty;

  return (
    <ChartIdsContext.Provider value={ids}>
      <section aria-labelledby={ids.titleId} className={cn("flex min-w-0 flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-[var(--shadow-card)] sm:p-5 rp-forced-border", className)}>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Heading id={ids.titleId} className="text-base font-semibold break-words text-ink">
              {title}
            </Heading>
            {description ? <div className="mt-0.5 text-sm break-words text-muted">{description}</div> : null}
          </div>
          <div className="flex max-w-full flex-wrap items-center gap-2">
            {showData ? (
              <SegmentedControl
                label={`${title}: view`}
                size="sm"
                value={view}
                onValueChange={setView}
                options={[
                  { value: "chart", label: "Chart", icon: BarChart3 },
                  { value: "table", label: "Table", icon: Table2 },
                ]}
              />
            ) : null}
            {actions}
          </div>
        </div>

        {/* Patterns live outside the caller's SVG so legend swatches resolve in both views. */}
        <svg aria-hidden="true" focusable="false" width="0" height="0" className="absolute">
          <ChartPatterns />
        </svg>

        {error ? (
          <ErrorState error={error} onRetry={onRetry} />
        ) : loading ? (
          <div role="status" aria-label={`Loading ${title}`} className="flex flex-col gap-2">
            <Skeleton className="h-48" />
            <span className="sr-only">Loading {title}</span>
          </div>
        ) : empty ? (
          <>{empty === true ? <EmptyState title="No data for this selection" size="sm" headingLevel={3} /> : empty}</>
        ) : (
          <>
            <p id={ids.summaryId} className="text-sm break-words text-body">
              {summary}
            </p>
            {view === "chart" ? <div className="min-w-0 [&>svg]:h-auto [&>svg]:w-full [&>svg]:max-w-full">{children}</div> : <div className="min-w-0">{table}</div>}
            {legend && legend.length && view === "chart" ? (
              <ul aria-label={`${title}: legend`} className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-body">
                {legend.map((item) => (
                  <li key={`${item.series}-${item.label}`} className="inline-flex min-w-0 items-center gap-2">
                    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" className="size-4 shrink-0">
                      <rect x="0.5" y="0.5" width="15" height="15" rx="3" className={cn(item.pattern ? undefined : SERIES_FILL[item.series], "stroke-line")} fill={item.pattern ? ids.patternFill(item.series) : undefined} />
                    </svg>
                    <span className="min-w-0 break-words">{item.label}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </section>
    </ChartIdsContext.Provider>
  );
}
