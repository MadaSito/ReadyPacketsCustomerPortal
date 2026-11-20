import { FileText, MessageSquare, PackagePlus } from "lucide-react";
import { Link } from "wouter";
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
  return (
    <Card>
      <EmptyState
        icon={PackagePlus}
        className="border-0 px-0"
        title="Let's get your first order started"
        description="Your dashboard fills in once you have orders. Here's how it works."
        action={
          <Button asChild>
            <Link href="/orders">Go to orders</Link>
          </Button>
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
