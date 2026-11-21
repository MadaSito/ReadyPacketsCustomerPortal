/**
 * Increment 04 — order page: phase rail, "what is needed before the next step" checklist, acknowledgement dialog
 * and the staff phase-unlock dialog. Owner: orders_engineer. Renders nothing when the order's workflow has no
 * phases or requirements. The server decides everything (counts, who may accept, locks); this only displays.
 * Acknowledgement text is user content from the workflow: rendered as plain text (React escapes it), never HTML.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Link } from "wouter";
import { Badge, Button, buttonClasses, Callout, Checkbox, Checklist, Dialog, Field, Input, PhaseRail, Select, Switch, Textarea, useToast } from "@/ui";

type RulesView = inferRouterOutputs<AppRouter>["orders"]["requirements"]["forOrder"];
type Ack = RulesView["acknowledgements"][number];

export function WorkflowRulesPanel({ orderId, area }: { orderId: string; area: "customer" | "console" }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.orders.requirements.forOrder.queryOptions({ orderId }));
  const [ack, setAck] = useState<Ack | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const data = query.data;
  if (!data) return null;
  const hasRules = data.phases.length > 0 || data.uploads.length > 0 || data.acknowledgements.length > 0;
  if (!hasRules) return null;
  const filesHref = `${area === "console" ? "/admin/orders" : "/orders"}/${orderId}/files`;
  const items = [
    ...data.uploads.map((slot) => ({
      key: `upload:${slot.key}`,
      label: slot.label,
      description: [
        slot.hint,
        uploadSummary(slot),
        slot.allowedTypes.length ? `Accepted: ${slot.allowedTypes.map((type) => type.toUpperCase()).join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(". "),
      state: slot.met ? (slot.minCount === 0 ? ("optional" as const) : ("done" as const)) : data.readOnly ? ("blocked" as const) : ("todo" as const),
      action: slot.canUpload ? (
        <Link href={filesHref} className={buttonClasses("secondary", "sm")} aria-label={`Upload ${slot.label}`}>
          Upload
        </Link>
      ) : undefined,
    })),
    ...data.acknowledgements.map((item) => ({
      key: `ack:${item.key}`,
      label: item.title,
      description: item.met
        ? "Accepted"
        : item.acceptedBy === "customer"
          ? area === "console"
            ? "Waiting for the customer to accept"
            : "Please read and accept"
          : area === "console"
            ? "Our team needs to accept this"
            : "Our team will confirm this",
      state: item.met ? ("done" as const) : item.canAccept ? ("todo" as const) : ("blocked" as const),
      action: item.canAccept ? (
        <Button variant="primary" size="sm" onClick={() => setAck(item)} aria-label={`Read and accept: ${item.title}`}>
          Read and accept
        </Button>
      ) : undefined,
    })),
  ];
  const lockedPhases = data.phases.filter((phase) => phase.locked);
  return (
    <section aria-labelledby={`rules-${orderId}`} className="mb-6 flex min-w-0 flex-col gap-4">
      <h2 id={`rules-${orderId}`} className="sr-only">
        Order progress
      </h2>
      {data.phases.length > 0 ? (
        <PhaseRail
          label="Order phases"
          steps={data.phases.map((phase) => ({
            key: phase.key,
            label: phase.label,
            state: phase.locked ? "locked" : phase.position,
            meta: phase.locked ? <Badge tone="neutral">Locked</Badge> : undefined,
          }))}
        />
      ) : null}
      {data.readOnlyReason === "order_locked" ? null : lockedPhases.length > 0 && area === "customer" ? (
        <Callout tone="info">Earlier phases are locked so your submitted items stay as they were reviewed. Contact us if something needs to change.</Callout>
      ) : null}
      {items.length > 0 ? (
        <Checklist
          title={`Needed before the next step (${data.status.label})`}
          headingLevel={3}
          items={items}
        />
      ) : null}
      {data.canUnlock ? (
        <div>
          <Button variant="secondary" onClick={() => setUnlockOpen(true)}>
            Unlock a phase
          </Button>
        </div>
      ) : null}
      {ack ? <AcknowledgementDialog orderId={orderId} statusKey={data.status.key} ack={ack} onClose={() => setAck(null)} /> : null}
      {unlockOpen ? <UnlockPhaseDialog orderId={orderId} phases={lockedPhases.map((phase) => ({ key: phase.key, label: phase.label }))} onClose={() => setUnlockOpen(false)} /> : null}
    </section>
  );
}

function uploadSummary(slot: RulesView["uploads"][number]): string {
  const noun = slot.kind === "audio" ? "audio file" : "file";
  const need = slot.minCount > 0 ? `${slot.minCount} needed` : "optional";
  return `${slot.count} ${noun}${slot.count === 1 ? "" : "s"} uploaded (${need}, up to ${slot.maxCount})`;
}

export function AcknowledgementDialog({ orderId, statusKey, ack, onClose }: { orderId: string; statusKey: string; ack: Ack; onClose: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [agreed, setAgreed] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation(
    trpc.orders.requirements.acknowledge.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.orders.requirements.forOrder.queryKey({ orderId }) });
        toast.show({ tone: "success", title: "Accepted", description: ack.title });
        onClose();
      },
      onError: (failure) => setError(errorMessage(failure)),
    }),
  );
  const nameMissing = ack.requireTypedName && typedName.trim().length < 2;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!agreed) return setError("Tick the box to confirm you have read and accept the text.");
    if (nameMissing) return setError("Type your full name to confirm.");
    mutation.mutate({ orderId, statusKey, ackKey: ack.key, textSha256: ack.textSha256, ...(ack.requireTypedName ? { typedName: typedName.trim() } : {}) });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => (!open ? onClose() : undefined)}
      title={ack.title}
      description="Read the full text, then confirm below. Your acceptance is recorded with the date and time."
      size="lg"
      dismissible={!mutation.isPending}
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {/* Scrollable text must be keyboard-focusable (WCAG 2.1.1, axe scrollable-region-focusable). */}
        <div
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label={`Full text: ${ack.title}`}
          className="max-h-[50dvh] overflow-y-auto rounded-[var(--radius-control)] border border-line bg-canvas p-3 text-sm break-words whitespace-pre-wrap text-body"
        >
          {ack.body}
        </div>
        <Checkbox label="I have read and accept this text" checked={agreed} onCheckedChange={setAgreed} required />
        {ack.requireTypedName ? (
          <Field label="Type your full name" required>
            <Input value={typedName} onChange={(event) => setTypedName(event.target.value)} maxLength={120} autoComplete="name" />
          </Field>
        ) : null}
        {error ? (
          <Callout tone="danger" live>
            {error}
          </Callout>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            Accept
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function UnlockPhaseDialog({ orderId, phases, onClose }: { orderId: string; phases: { key: string; label: string }[]; onClose: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [phaseKey, setPhaseKey] = useState(phases[0]?.key ?? "");
  const [reason, setReason] = useState("");
  const [notifyCustomer, setNotify] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation(
    trpc.orders.phases.unlock.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.orders.requirements.forOrder.queryKey({ orderId }) });
        toast.show({ tone: "success", title: "Phase unlocked", description: "It locks again at the next status change." });
        onClose();
      },
      onError: (failure) => setError(errorMessage(failure)),
    }),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (reason.trim().length < 10) return setError("Give a reason of at least 10 characters.");
    mutation.mutate({ orderId, phaseKey, reason: reason.trim(), notifyCustomer });
  };
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)} title="Unlock a phase" description="Unlocking lets the customer and staff change that phase again until the next status change. The reason is kept as an internal note." dismissible={!mutation.isPending}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Phase" required>
          <Select value={phaseKey} onChange={(event) => setPhaseKey(event.target.value)} options={phases.map((phase) => ({ value: phase.key, label: phase.label }))} />
        </Field>
        <Field label="Reason" hint="10 to 500 characters. Staff only." required>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={3} />
        </Field>
        <Switch label="Notify the customer" checked={notifyCustomer} onCheckedChange={setNotify} />
        {error ? (
          <Callout tone="danger" live>
            {error}
          </Callout>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            Unlock
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
