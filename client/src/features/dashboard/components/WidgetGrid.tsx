/**
 * Renders registry widgets for an area on a 12-column grid (full width < lg). Each widget is isolated in
 * its own error boundary + Suspense so one failing card never breaks the dashboard.
 */
import { Component, Suspense, type ComponentType, type ReactNode } from "react";
import type { UserRole } from "@shared/domain";
import type { DashboardWidget, RouteAccess } from "@/lib/routes";
import { Card, Skeleton } from "@/ui";
import { cn } from "@/ui/cn";

const SPAN: Record<DashboardWidget["span"], string> = { 4: "lg:col-span-4", 6: "lg:col-span-6", 8: "lg:col-span-8", 12: "lg:col-span-12" };

export function canSee(access: RouteAccess, role: UserRole): boolean {
  if (access === "admin") return role === "admin";
  if (access === "staff") return role === "staff" || role === "admin";
  return true;
}

export function widgetsFor(widgets: readonly DashboardWidget[], area: DashboardWidget["area"], role: UserRole): DashboardWidget[] {
  return widgets.filter((w) => w.area === area && canSee(w.access, role)).sort((a, b) => a.order - b.order);
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
  return (
    <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-12">
      {widgets.map((w) => {
        const Widget = w.component as ComponentType;
        return (
          <div key={w.key} className={cn("min-w-0", SPAN[w.span])}>
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
