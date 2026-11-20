/**
 * Renders registry widgets for an area: 1 column on phones, 2 columns from md, 12 columns from lg. Rows are
 * packed so they never leave a ragged gap (leftover columns are shared across the row's cards), and cards in
 * a row are equal height. Each widget is isolated in its own error boundary + Suspense so one failing card
 * never breaks the dashboard.
 */
import { Component, Suspense, type ComponentType, type ReactNode } from "react";
import type { UserRole } from "@shared/domain";
import type { DashboardWidget, RouteAccess } from "@/lib/routes";
import { Card, Skeleton } from "@/ui";
import { cn } from "@/ui/cn";

const LG_SPAN: Record<number, string> = {
  1: "lg:col-span-1", 2: "lg:col-span-2", 3: "lg:col-span-3", 4: "lg:col-span-4", 5: "lg:col-span-5", 6: "lg:col-span-6",
  7: "lg:col-span-7", 8: "lg:col-span-8", 9: "lg:col-span-9", 10: "lg:col-span-10", 11: "lg:col-span-11", 12: "lg:col-span-12",
};
const MD_SPAN: Record<number, string> = { 1: "md:col-span-1", 2: "md:col-span-2" };

/**
 * Greedy row packing: fill rows of `columns` in order. A row with spare columns becomes equal-width cards
 * when every card fits that width; otherwise the spare columns are shared (remainder to the last card).
 * Returns each card's span.
 */
export function packRows(spans: readonly number[], columns: number): number[] {
  const out: number[] = [];
  let row: number[] = [];
  const flush = () => {
    const used = row.reduce((sum, i) => sum + (spans[i] ?? 0), 0);
    const leftover = Math.max(0, columns - used);
    const equal = columns / row.length;
    if (leftover > 0 && Number.isInteger(equal) && row.every((i) => (spans[i] ?? 0) <= equal)) {
      row.forEach((i) => (out[i] = equal));
      row = [];
      return;
    }
    const each = Math.floor(leftover / row.length);
    row.forEach((i, k) => {
      out[i] = (spans[i] ?? 0) + each + (k === row.length - 1 ? leftover - each * row.length : 0);
    });
    row = [];
  };
  spans.forEach((raw, i) => {
    const span = Math.min(Math.max(1, raw), columns);
    const used = row.reduce((sum, j) => sum + (spans[j] ?? 0), 0);
    if (row.length && used + span > columns) flush();
    row.push(i);
  });
  if (row.length) flush();
  return out;
}

/** Spans for the md (2-column) and lg (12-column) layouts. Wide cards (span ≥ 8) take both md columns. */
export function gridSpans(widgets: readonly Pick<DashboardWidget, "span">[]): Array<{ md: number; lg: number }> {
  const lg = packRows(widgets.map((w) => w.span), 12);
  const md = packRows(widgets.map((w) => (w.span >= 8 ? 2 : 1)), 2);
  return widgets.map((_, i) => ({ md: md[i] ?? 2, lg: lg[i] ?? 12 }));
}

export function canSee(access: RouteAccess, role: UserRole): boolean {
  if (access === "admin") return role === "admin";
  if (access === "staff") return role === "staff" || role === "admin";
  return true;
}

export function widgetsFor(widgets: readonly DashboardWidget[], area: DashboardWidget["area"], role: UserRole): DashboardWidget[] {
  // Ties on `order` put the narrower card first so it leads its row (e.g. a 4-wide status card beside an 8-wide one).
  return widgets.filter((w) => w.area === area && canSee(w.access, role)).sort((a, b) => a.order - b.order || a.span - b.span);
}

class WidgetBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <Card>
        <p className="text-sm text-body">This card couldn't load. Refresh the page to try again.</p>
      </Card>
    ) : (
      this.props.children
    );
  }
}

export function WidgetGrid({ widgets, empty }: { widgets: readonly DashboardWidget[]; empty?: ReactNode }) {
  if (widgets.length === 0) return <>{empty ?? null}</>;
  const spans = gridSpans(widgets);
  return (
    <div className="grid grid-cols-1 items-stretch gap-4 sm:gap-6 md:grid-cols-2 lg:grid-cols-12">
      {widgets.map((w, i) => {
        const Widget = w.component as ComponentType;
        const span = spans[i] ?? { md: 2, lg: 12 };
        return (
          <div key={w.key} data-widget={w.key} className={cn("flex min-w-0 flex-col *:flex-1", MD_SPAN[span.md], LG_SPAN[span.lg])}>
            <WidgetBoundary>
              <Suspense
                fallback={
                  <Card>
                    <Skeleton lines={3} />
                  </Card>
                }
              >
                <Widget />
              </Suspense>
            </WidgetBoundary>
          </div>
        );
      })}
    </div>
  );
}
