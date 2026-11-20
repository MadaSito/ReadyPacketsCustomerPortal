import { LayoutDashboard } from "lucide-react";
import { WIDGETS } from "@/app/registry";
import { useSession } from "@/lib/session";
import { Card, EmptyState, PageHeader } from "@/ui";
import { WidgetGrid, widgetsFor } from "../components/WidgetGrid";

export default function ConsoleOverviewPage() {
  const { me } = useSession();
  const user = me?.user;
  const widgets = user ? widgetsFor(WIDGETS, "console", user.role) : [];
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <PageHeader title="Overview" description="Operational health, workload and security signals across ReadyPackets." />
      <WidgetGrid
        widgets={widgets}
        empty={
          <Card>
            <EmptyState icon={LayoutDashboard} className="border-0" title="No overview cards yet" description="Cards appear here as features are enabled for your role." />
          </Card>
        }
      />
    </div>
  );
}
