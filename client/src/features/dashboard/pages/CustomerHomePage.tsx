import { FileText, MessageSquare, PackagePlus } from "lucide-react";
import { Link } from "wouter";
import { NewOrderForCustomerLink, useIsStaffViewer } from "@/app/portal";
import { WIDGETS } from "@/app/registry";
import { useSession } from "@/lib/session";
import { Button, Card, EmptyState, PageHeader } from "@/ui";
import { RequiredActions } from "../components/RequiredActions";
import { WidgetGrid, widgetsFor } from "../components/WidgetGrid";

export function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const STEPS = [
  { icon: PackagePlus, title: "Start an order", body: "Tell us what you need and upload your source documents securely." },
  { icon: MessageSquare, title: "Stay in touch", body: "Ask questions and get updates in one secure thread per order." },
  { icon: FileText, title: "Receive your packet", body: "Download finished deliverables with a private, single-use link." },
];

function FirstOrderGuide() {
  // 07.1 D4: staff and admins do not own orders; they create them for a customer from the console.
  const staff = useIsStaffViewer();
  return (
    <Card>
      <EmptyState
        icon={PackagePlus}
        className="border-0 px-0"
        title={staff ? "Orders are placed for a customer" : "Let's get your first order started"}
        description={staff ? "This is the customer portal. Create an order for a customer from the console; it then appears in their portal." : "Your dashboard fills in once you have orders. Here's how it works."}
        action={
          staff ? (
            <div className="flex flex-wrap justify-center gap-3">
              <NewOrderForCustomerLink />
              <Button asChild variant="secondary">
                <Link href="/orders">Go to orders</Link>
              </Button>
            </div>
          ) : (
            <Button asChild>
              <Link href="/orders">Go to orders</Link>
            </Button>
          )
        }
      />
      <ol className="mt-2 grid gap-4 border-t border-line pt-6 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-3">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-action-soft text-sm font-semibold text-action" aria-hidden>
              {i + 1}
            </span>
            <div>
              <h3 className="font-semibold text-ink">{s.title}</h3>
              <p className="mt-1 text-sm text-body">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export default function CustomerHomePage() {
  const { me } = useSession();
  const user = me?.user;
  const firstName = user?.name.trim().split(/\s+/)[0];
  const widgets = user ? widgetsFor(WIDGETS, "customer", user.role) : [];
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <PageHeader title={firstName ? `${greeting()}, ${firstName}` : "Welcome"} description="Here's what's happening with your ReadyPackets orders." />
      <RequiredActions />
      <WidgetGrid widgets={widgets} empty={<FirstOrderGuide />} />
    </div>
  );
}
