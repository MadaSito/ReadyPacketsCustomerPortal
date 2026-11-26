/**
 * Increment 08 (D6) — the customer wizard for orders whose workflow has no phase actions ("derived" formats 1/2;
 * audit_engineer). It offers only what the server already allows: the workflow acknowledgements, the order's intake
 * questionnaires, document and audio uploads (files_engineer's unscoped `FileUploadPanel`), then "Finish" when the
 * order has exactly one forward status change the customer may make. With nothing to do it shows the waiting screen.
 * No new permissions: every call is the same one the order details already make, and the server checks it again.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";
import { safeError, useTRPC } from "@/lib/trpc";
import { Button, Card, Skeleton } from "@/ui";
import OrderIntakeTab from "../../compliance/customer/OrderIntakeTab";
import { FileUploadPanel } from "../../files/FileUploadPanel";
import { AcknowledgementDialog } from "../WorkflowRulesPanel";
import { StepWizard } from "./StepWizard";
import { WaitingScreen } from "./WaitingScreen";
import { buildSteps, openRequirements, resumeIndex, stepExtensions, wizardErrorMessage, type WaitingKind, type WizardStepKey } from "./wizardModel";

type Outputs = inferRouterOutputs<AppRouter>;
type Rules = Outputs["orders"]["requirements"]["forOrder"];
type Ack = Rules["acknowledgements"][number];
type Upload = Rules["uploads"][number];
type FilesPage = Outputs["files"]["list"];
type Slot = NonNullable<FilesPage["uploadSlots"]>["slots"][number];
type Transition = Outputs["orders"]["get"]["transitions"][number];

const DONE_INTAKE = new Set(["submitted", "accepted", "imported"]);

/** The one forward status change "Finish" makes: exactly one non-cancel change without a required note. */
export function finishTransition(transitions: readonly Transition[]): Transition | null {
  const forward = transitions.filter((t) => !t.destructive);
  return forward.length === 1 && !forward[0]!.requiresNote ? forward[0]! : null;
}

/** Upload requirement totals for one kind: still-needed minimum and files counted toward it. */
export function uploadTotals(uploads: readonly Pick<Upload, "kind" | "minCount" | "count" | "waived">[], kind: "document" | "audio") {
  const mine = uploads.filter((u) => (kind === "audio" ? u.kind === "audio" : u.kind !== "audio") && !u.waived);
  return {
    required: mine.reduce((n, u) => n + u.minCount, 0),
    provided: mine.reduce((n, u) => n + (u.minCount > 0 ? Math.min(u.count, u.minCount) : u.count), 0),
  };
}

export function DerivedOrderWizard({ orderId, waitingKind, waitingAction }: {
  orderId: string;
  /** What the order waits for when the customer has nothing to do (payment, team, delivered, canceled …). */
  waitingKind: WaitingKind;
  waitingAction?: ReactNode;
}) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const order = useQuery(trpc.orders.get.queryOptions({ orderId }));
  const rules = useQuery(trpc.orders.requirements.forOrder.queryOptions({ orderId }));
  const files = useQuery(trpc.files.list.queryOptions({ orderId, limit: 1 }));
  const intake = useQuery(trpc.compliance.intake.listForOrder.queryOptions({ orderPublicId: orderId }));
  // The order-level agreement gate (same cache as the gate card above the wizard).
  const gate = useQuery(trpc.compliance.acceptance.forOrder.queryOptions({ orderId }));
  const transition = useMutation(trpc.orders.transition.mutationOptions());
  const [ack, setAck] = useState<Ack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, number>>({});
  const pendingFor = (key: string) => (count: number) => setPending((prev) => (prev[key] === count ? prev : { ...prev, [key]: count }));
  const pendingOf = (kind: "document" | "audio") => Object.entries(pending).reduce((n, [k, c]) => (k.startsWith(`${kind}:`) ? n + c : n), 0);

  if (order.isPending || rules.isPending || files.isPending || intake.isPending || gate.isPending) {
    return <div role="status" aria-label="Loading your order steps" className="mb-6"><Skeleton lines={4} /></div>;
  }
  if (!order.data) return null;

  const terminal = order.data.statusKind === "terminal";
  // One accept prompt at a time: while the agreement gate above is pending, the wizard waits for it.
  const gatePending = (gate.data?.gates ?? []).some((g) => g.required && g.applies && !g.met);
  if (!terminal && gatePending) {
    return (
      <Card>
        <p className="p-4 text-body sm:px-6" data-wizard-waiting="agreement">Accept the agreement above to continue.</p>
      </Card>
    );
  }
  const r = rules.data;
  const page = files.data;
  const policy = page?.canUpload ? page.uploadPolicy : null;
  const slots: Slot[] = (page?.uploadSlots?.slots ?? []).filter((s) => s.acceptsUpload !== false);
  const statusKey = page?.uploadSlots?.statusKey ?? "";
  const docSlots = slots.filter((s) => s.kind !== "audio");
  const audioSlots = slots.filter((s) => s.kind === "audio");
  const docExt = policy ? stepExtensions(policy.extensions, "document") : [];
  const audioExt = policy ? stepExtensions(policy.extensions, "audio") : [];
  const audioOn = Boolean(policy) && audioExt.length > 0 && (audioSlots.length > 0 || page?.audio?.enabled === true);
  const docsOn = Boolean(policy) && docExt.length > 0 && (docSlots.length > 0 || slots.length === 0);
  const acks = (r?.acknowledgements ?? []).filter((a) => a.acceptedBy === "customer");
  const intakeItems = intake.data?.items ?? [];
  const docTotals = uploadTotals(r?.uploads ?? [], "document");
  const audioTotals = uploadTotals(r?.uploads ?? [], "audio");

  const steps = terminal ? [] : buildSteps({
    accept: { present: acks.some((a) => a.canAccept || !a.met), required: acks.filter((a) => !a.met && a.canAccept).length, provided: 0 },
    questions: {
      present: intakeItems.length > 0,
      required: intakeItems.filter((i) => !DONE_INTAKE.has(i.submission?.status ?? "not_started")).length,
      provided: 0,
    },
    documents: { present: docsOn, required: docTotals.required, provided: docTotals.provided, pending: pendingOf("document") },
    audio: { present: audioOn, required: audioTotals.required, provided: audioTotals.provided, pending: pendingOf("audio") },
  });
  // Only the review step: nothing the customer can do here — explain what happens next instead.
  if (steps.length <= 1) {
    return (
      <Card>
        <div className="p-4 sm:p-6">
          <WaitingScreen kind={waitingKind} action={waitingAction} />
        </div>
      </Card>
    );
  }

  const finish = finishTransition(order.data.transitions);
  const open = openRequirements(steps);
  const changed = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: trpc.files.list.pathKey() }),
      client.invalidateQueries({ queryKey: trpc.orders.requirements.forOrder.queryKey({ orderId }) }),
    ]);
  };
  const runFinish = async () => {
    if (!finish) return;
    setError(null);
    try {
      await transition.mutateAsync({ orderId, expectedVersion: order.data.version, toStatus: finish.to });
      await Promise.all([
        client.invalidateQueries({ queryKey: trpc.orders.get.queryKey({ orderId }) }),
        client.invalidateQueries({ queryKey: trpc.orders.list.queryKey() }),
        changed(),
      ]);
    } catch (e) {
      const safe = safeError(e);
      setError(wizardErrorMessage(safe?.reasonCode, safe?.safeMessage));
    }
  };
  const uploadPanel = (kind: "document" | "audio", slot: Slot | undefined) => {
    if (!policy) return null;
    const extensions = stepExtensions(policy.extensions, kind, slot?.allowedTypes ?? []);
    if (!extensions.length) return null;
    const key = `${kind}:${slot?.key ?? "order"}`;
    return (
      <div key={key} className="min-w-0">
        {slot ? <h5 className="mb-2 break-words text-sm font-semibold text-ink">{slot.label}</h5> : null}
        <FileUploadPanel
          orderId={orderId}
          staff={false}
          policy={{ ...policy, extensions }}
          slot={slot ? { ...slot, statusKey } : undefined}
          audio={kind === "audio" ? page?.audio : undefined}
          onPendingChange={pendingFor(key)}
          onChanged={changed}
        />
      </div>
    );
  };

  const renderStep = (key: WizardStepKey): ReactNode => {
    switch (key) {
      case "accept":
        return (
          <ul className="grid min-w-0 gap-2">
            {acks.map((a) => (
              <li key={a.key} className="flex min-w-0 flex-col gap-2 rounded-[var(--radius-control)] border border-line p-3 sm:flex-row sm:items-center sm:justify-between">
                <span className="min-w-0 break-words font-medium text-ink">{a.title}</span>
                {a.met ? <span className="text-sm text-body">Accepted</span>
                  : a.canAccept ? <Button size="sm" onClick={() => setAck(a)} aria-label={`Read and accept: ${a.title}`}>Read and accept</Button>
                  : <span className="text-sm text-body">Our team is preparing this</span>}
              </li>
            ))}
          </ul>
        );
      case "questions":
        return <OrderIntakeTab orderId={orderId} area="customer" />;
      case "documents":
        return <div className="flex min-w-0 flex-col gap-4">{docSlots.length ? docSlots.map((s) => uploadPanel("document", s)) : uploadPanel("document", undefined)}</div>;
      case "audio":
        return <div className="flex min-w-0 flex-col gap-4">{audioSlots.length ? audioSlots.map((s) => uploadPanel("audio", s)) : uploadPanel("audio", undefined)}</div>;
      case "review":
        return (
          <div className="flex min-w-0 flex-col gap-3">
            <ul className="grid min-w-0 gap-2" aria-label="What you provided">
              {steps.filter((s) => s.key !== "review").map((s) => (
                <li key={s.key} className="flex min-w-0 flex-col gap-0.5 rounded-[var(--radius-control)] border border-line p-3 sm:flex-row sm:justify-between sm:gap-3">
                  <span className="font-medium text-ink">{s.title}</span>
                  <span className="break-words text-sm text-body">{s.complete ? "Done" : s.blockedReason ?? "Optional, not done"}</span>
                </li>
              ))}
            </ul>
            {finish ? null : <WaitingScreen kind={waitingKind} headingLevel={4} action={waitingAction} />}
          </div>
        );
    }
  };

  return (
    <section aria-label="Your order steps" className="mb-6">
      <Card>
        <div className="p-4 sm:p-6">
          <StepWizard
            label="Steps for this order"
            headingLevel={3}
            steps={steps}
            initialIndex={resumeIndex(steps)}
            renderStep={renderStep}
            errors={error ? [{ message: error }] : []}
            final={{
              label: finish ? (finish.actionLabel ?? "Finish") : "Finish",
              busy: transition.isPending,
              disabledReason: open.length
                ? "Complete the steps marked Not done first."
                : finish ? null : "There is nothing more to send now; our team takes it from here.",
              run: () => void runFinish(),
            }}
          />
        </div>
      </Card>
      {ack && r ? <AcknowledgementDialog orderId={orderId} statusKey={r.status.key} ack={ack} onClose={() => setAck(null)} /> : null}
    </section>
  );
}
