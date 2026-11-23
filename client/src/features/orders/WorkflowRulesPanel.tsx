/**
 * Increment 04 — order page: phase rail, "what is needed before the next step" checklist, acknowledgement dialog
 * and the staff phase-unlock dialog. Owner: orders_engineer. Renders nothing when the order's workflow has no
 * phases or requirements. The server decides everything (counts, who may accept, locks); this only displays.
 * Acknowledgement text is user content from the workflow: rendered as plain text (React escapes it), never HTML.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";
import { AgreementDialog, parseAgreementRequiredDetails, type AgreementRequiredDetails } from "@/lib/agreementGate";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Link } from "wouter";
import { Badge, Button, buttonClasses, Callout, Checkbox, Checklist, Dialog, Field, Input, PhaseRail, Select, Switch, Textarea, useToast, type ChecklistItem } from "@/ui";

type RulesView = inferRouterOutputs<AppRouter>["orders"]["requirements"]["forOrder"];
type Ack = RulesView["acknowledgements"][number];

type Upload = RulesView["uploads"][number];
type DocTask = RulesView["documents"][number];
type WaiveTarget = { taskKey: string; label: string };

/** Increment 06 (D8): Files tab deep link (`?slot=` preselects and focuses; `mode=record` opens the recorder). */
export function taskFilesHref(area: "customer" | "console", orderId: string, slotKey: string, record = false): string {
  const base = `${area === "console" ? "/admin/orders" : "/orders"}/${orderId}/files`;
  return `${base}?slot=${encodeURIComponent(slotKey)}${record ? "&mode=record" : ""}`;
}

export function WorkflowRulesPanel({ orderId, area }: { orderId: string; area: "customer" | "console" }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.orders.requirements.forOrder.queryOptions({ orderId }));
  const [ack, setAck] = useState<Ack | null>(null);
  const [docAck, setDocAck] = useState<DocTask | null>(null);
  const [noteFor, setNoteFor] = useState<Ack | null>(null);
  const [waive, setWaive] = useState<WaiveTarget | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [agreementOpen, setAgreementOpen] = useState(false);
  const queryClient = useQueryClient();
  const data = query.data;
  if (!data) return null;
  const agreement = area === "customer" ? data.agreementPending : null;
  const documents = data.documents ?? [];
  const hasRules = data.phases.length > 0 || data.uploads.length > 0 || data.acknowledgements.length > 0 || documents.length > 0;
  if (!hasRules) return null;
  // Part B / D14: an unmet acceptance gate or order agreement pauses the customer's work. The server refuses anyway.
  const paused = area === "customer" && (data.acceptancePending === true || Boolean(data.agreementPending));
  const pausedId = `rules-paused-${orderId}`;
  const pausedProps = { disabled: true, "aria-describedby": pausedId } as const;
  const waiveButton = (met: boolean, waived: boolean, taskKey: string, label: string) =>
    area === "console" && data.canWaive && !met && !waived ? (
      <Button variant="ghost" size="sm" onClick={() => setWaive({ taskKey, label })} aria-label={`Waive ${label}`}>
        Waive
      </Button>
    ) : null;
  const actions = (...nodes: ReactNode[]) => {
    const shown = nodes.filter(Boolean);
    return shown.length ? <div className="flex flex-wrap gap-2">{shown}</div> : undefined;
  };
  const items: ChecklistItem[] = [
    ...data.uploads.map((slot) => {
      const record = slot.taskKind === "record";
      const verb = record ? (slot.capture === "upload" ? "Upload" : "Record") : "Upload";
      const href = taskFilesHref(area, orderId, slot.key, record && slot.capture !== "upload");
      return {
        key: `upload:${slot.key}`,
        label: slot.label,
        // Parts are joined with ". ", so a hint's own closing punctuation is dropped (no "files.. 0 files").
        description: slot.waived
          ? "Waived by our team"
          : [
              slot.hint ? slot.hint.trim().replace(/[.!?]+$/, "") : null,
              uploadSummary(slot),
              record ? recordSummary(slot) : null,
              slot.allowedTypes.length ? `Accepted: ${slot.allowedTypes.map((type) => type.toUpperCase()).join(", ")}` : null,
            ]
              .filter(Boolean)
              .join(". "),
        state: slot.met ? (slot.minCount === 0 && !slot.waived ? ("optional" as const) : ("done" as const)) : data.readOnly ? ("blocked" as const) : ("todo" as const),
        action: actions(
          slot.canUpload && paused ? (
            <Button key="go" variant="secondary" size="sm" aria-label={`${verb} ${slot.label}`} {...pausedProps}>
              {verb}
            </Button>
          ) : slot.canUpload && !slot.waived ? (
            <Link key="go" href={href} className={buttonClasses("secondary", "sm")} aria-label={`${verb} ${slot.label}`}>
              {verb}
            </Link>
          ) : null,
          waiveButton(slot.met, slot.waived, slot.key, slot.label),
        ),
      };
    }),
    ...data.acknowledgements.map((item) => {
      const fromNote = item.source === "order_note";
      const waiting = fromNote && item.orderNote === null;
      return {
        key: `ack:${item.key}`,
        label: item.title,
        description: item.waived
          ? "Waived by our team"
          : item.met
            ? "Accepted"
            : waiting
              ? area === "console"
                ? "Write the note the customer must acknowledge"
                : "Our team is preparing this note"
              : item.acceptedBy === "customer"
                ? area === "console"
                  ? "Waiting for the customer to accept"
                  : "Please read and accept"
                : area === "console"
                  ? "Our team needs to accept this"
                  : "Our team will confirm this",
        state: item.met ? ("done" as const) : item.canAccept ? ("todo" as const) : ("blocked" as const),
        action: actions(
          item.canAccept && paused ? (
            <Button key="go" variant="primary" size="sm" aria-label={`Read and accept: ${item.title}`} {...pausedProps}>
              Read and accept
            </Button>
          ) : item.canAccept ? (
            <Button key="go" variant="primary" size="sm" onClick={() => setAck(item)} aria-label={`Read and accept: ${item.title}`}>
              Read and accept
            </Button>
          ) : null,
          area === "console" && item.canEditNote ? (
            <Button key="note" variant="secondary" size="sm" onClick={() => setNoteFor(item)} aria-label={`${waiting ? "Write note" : "Edit note"}: ${item.title}`}>
              {waiting ? "Write note" : "Edit note"}
            </Button>
          ) : null,
          waiveButton(item.met, item.waived, item.key, item.title),
        ),
      };
    }),
    ...documents.map((doc) => {
      const ready = doc.sourceCount > 0;
      const modes = doc.responseModes;
      return {
        key: `doc:${doc.key}`,
        label: doc.label,
        description: doc.waived
          ? "Waived by our team"
          : doc.met
            ? doc.acknowledged
              ? "Acknowledged"
              : "Reply received"
            : !ready
              ? area === "console"
                ? "Upload the document the customer must respond to"
                : "Our team is preparing this document"
              : [doc.hint ? doc.hint.trim().replace(/[.!?]+$/, "") : null, area === "console" ? "Waiting for the customer to respond" : documentModesText(modes)].filter(Boolean).join(". "),
        state: doc.met ? ("done" as const) : !doc.required ? ("optional" as const) : ready && (doc.canReply || doc.canEdit || doc.canAcknowledge || area === "console") ? ("todo" as const) : ("blocked" as const),
        action: actions(
          area === "console" && doc.canStaffUpload ? (
            <Link key="src" href={taskFilesHref(area, orderId, doc.key)} className={buttonClasses("secondary", "sm")} aria-label={`${ready ? "Manage document" : "Upload document"}: ${doc.label}`}>
              {ready ? "Manage document" : "Upload document"}
            </Link>
          ) : null,
          area === "customer" && ready && !doc.met && doc.canEdit ? (
            paused ? (
              <Button key="edit" variant="primary" size="sm" aria-label={`Edit in portal: ${doc.label}`} {...pausedProps}>
                Edit in portal
              </Button>
            ) : (
              <Link key="edit" href={taskFilesHref(area, orderId, doc.key)} className={buttonClasses("primary", "sm")} aria-label={`Edit in portal: ${doc.label}`}>
                Edit in portal
              </Link>
            )
          ) : null,
          area === "customer" && ready && !doc.met && doc.canReply && modes.includes("upload_reply") ? (
            paused ? (
              <Button key="reply" variant="secondary" size="sm" aria-label={`Upload reply: ${doc.label}`} {...pausedProps}>
                Upload reply
              </Button>
            ) : (
              <Link key="reply" href={taskFilesHref(area, orderId, doc.replySlotKey)} className={buttonClasses("secondary", "sm")} aria-label={`Upload reply: ${doc.label}`}>
                Upload reply
              </Link>
            )
          ) : null,
          area === "customer" && ready && !doc.met && doc.canAcknowledge ? (
            <Button key="ack" variant="secondary" size="sm" aria-label={`Acknowledge: ${doc.label}`} onClick={() => setDocAck(doc)} {...(paused ? pausedProps : {})}>
              Acknowledge
            </Button>
          ) : null,
          area === "customer" && ready ? (
            <Link key="view" href={taskFilesHref(area, orderId, doc.key)} className="inline-flex min-h-11 items-center text-sm font-semibold text-link underline-offset-2 hover:underline" aria-label={`View document: ${doc.label}`}>
              View document
            </Link>
          ) : null,
          waiveButton(doc.met, doc.waived, doc.key, doc.label),
        ),
      };
    }),
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
      {paused && items.length > 0 ? (
        <Callout tone="warning">
          <span id={pausedId}>
            {data.agreementPending
              ? "Your tasks are paused until you accept the agreement."
              : "Uploads and acknowledgements are paused until you accept the policy shown above."}
          </span>
          {agreement ? (
            <span className="mt-2 block">
              <Button variant="primary" size="sm" onClick={() => setAgreementOpen(true)}>
                Review and accept the agreement
              </Button>
            </span>
          ) : null}
        </Callout>
      ) : null}
      {agreement ? (
        <AgreementDialog
          policyPublicId={agreement.policyPublicId}
          signatureMode={agreement.signatureMode}
          open={agreementOpen}
          onAccepted={async () => {
            setAgreementOpen(false);
            await queryClient.invalidateQueries({ queryKey: trpc.orders.requirements.forOrder.queryKey({ orderId }) });
          }}
          onClose={() => setAgreementOpen(false)}
        />
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
      {docAck ? (
        <AcknowledgementDialog
          orderId={orderId}
          statusKey={data.status.key}
          ack={{ key: docAck.key, title: docAck.label, body: docAck.hint ?? "", requireTypedName: false, textSha256: docAck.textSha256, orderNote: null, documentHref: taskFilesHref(area, orderId, docAck.key) }}
          onClose={() => setDocAck(null)}
        />
      ) : null}
      {noteFor ? <TaskNoteDialog orderId={orderId} statusKey={data.status.key} ack={noteFor} onClose={() => setNoteFor(null)} /> : null}
      {waive ? <WaiveTaskDialog orderId={orderId} statusKey={data.status.key} target={waive} onClose={() => setWaive(null)} /> : null}
      {unlockOpen ? <UnlockPhaseDialog orderId={orderId} phases={lockedPhases.map((phase) => ({ key: phase.key, label: phase.label }))} onClose={() => setUnlockOpen(false)} /> : null}
    </section>
  );
}

function recordSummary(slot: Upload): string {
  const how = slot.capture === "record" ? "Record in the portal" : slot.capture === "upload" ? "Upload a recording" : "Record in the portal or upload a recording";
  return slot.maxMinutes ? `${how} (up to ${slot.maxMinutes} minute${slot.maxMinutes === 1 ? "" : "s"})` : how;
}

function documentModesText(modes: readonly string[]): string {
  const parts = modes.map((mode) => (mode === "edit_in_portal" ? "edit it in the portal" : mode === "upload_reply" ? "upload your reply" : "acknowledge it"));
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} or ${parts.at(-1)}` : parts[0] ?? "";
  return `Read the document, then ${joined}`;
}

function uploadSummary(slot: Upload): string {
  const noun = slot.kind === "audio" ? "audio file" : "file";
  const need = slot.minCount > 0 ? `${slot.minCount} needed` : "optional";
  return `${slot.count} ${noun}${slot.count === 1 ? "" : "s"} uploaded (${need}, up to ${slot.maxCount})`;
}

/** What the dialog shows: a workflow acknowledgement, an order-note task, or a respond_document acknowledgement. */
export type AckDialogItem = Pick<Ack, "key" | "title" | "body" | "requireTypedName" | "textSha256"> & { orderNote?: string | null; documentHref?: string };

export function AcknowledgementDialog({ orderId, statusKey, ack, onClose }: { orderId: string; statusKey: string; ack: AckDialogItem; onClose: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [agreed, setAgreed] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // D14: the server may answer AGREEMENT_REQUIRED; accept the agreement, then retry the same request once.
  const [agreement, setAgreement] = useState<AgreementRequiredDetails | null>(null);
  const mutation = useMutation(
    trpc.orders.requirements.acknowledge.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.orders.requirements.forOrder.queryKey({ orderId }) });
        toast.show({ tone: "success", title: "Accepted", description: ack.title });
        onClose();
      },
      onError: (failure) => {
        const needed = parseAgreementRequiredDetails(failure);
        if (needed) return setAgreement(needed);
        setError(errorMessage(failure));
      },
    }),
  );
  const nameMissing = ack.requireTypedName && typedName.trim().length < 2;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!agreed) return setError("Tick the box to confirm you have read and accept the text.");
    if (nameMissing) return setError("Type your full name to confirm.");
    send();
  };
  const send = () => mutation.mutate({ orderId, statusKey, ackKey: ack.key, textSha256: ack.textSha256, ...(ack.requireTypedName ? { typedName: typedName.trim() } : {}) });
  if (agreement)
    return (
      <AgreementDialog
        policyPublicId={agreement.policyPublicId}
        signatureMode={agreement.signatureMode}
        open
        onAccepted={() => {
          setAgreement(null);
          send();
        }}
        onClose={() => {
          setAgreement(null);
          setError("Accept the agreement to continue.");
        }}
      />
    );
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
          {ack.orderNote ? `\n\n${ack.orderNote}` : null}
        </div>
        {ack.documentHref ? (
          <p className="text-sm text-body">
            <Link href={ack.documentHref} className="font-semibold text-link underline-offset-2 hover:underline">
              Open the document in the Files tab
            </Link>{" "}
            before you acknowledge it.
          </p>
        ) : null}
        <Checkbox label={ack.documentHref ? "I have read this document" : "I have read and accept this text"} checked={agreed} onCheckedChange={setAgreed} required />
        {ack.requireTypedName ? (
          <Field label="Type your full name" required>
            <Input value={typedName} onChange={(event) => setTypedName(event.target.value)} maxLength={120} autoComplete="name" />
          </Field>
        ) : null}
        {error ? (
          <Callout tone="danger" live="assertive">
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
          <Callout tone="danger" live="assertive">
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

/** Increment 06 (D8): staff write the per-order note a customer must acknowledge (frozen once acknowledged). */
export function TaskNoteDialog({ orderId, statusKey, ack, onClose }: { orderId: string; statusKey: string; ack: Ack; onClose: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState(ack.orderNote ?? "");
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation(
    trpc.orders.requirements.setTaskNote.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.orders.requirements.forOrder.queryKey({ orderId }) });
        toast.show({ tone: "success", title: "Note saved", description: "The customer can now read and acknowledge it." });
        onClose();
      },
      onError: (failure) => setError(errorMessage(failure)),
    }),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const text = body.trim();
    if (!text) return setError("Write the note the customer must read.");
    if (/<\s*[a-z!/?]/i.test(text)) return setError("Use plain text without markup.");
    mutation.mutate({ orderId, statusKey, ackKey: ack.key, body: text });
  };
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)} title={`Note for the customer: ${ack.title}`} description="The customer reads this note under the task text and acknowledges both. You can change it until they do." dismissible={!mutation.isPending} size="lg">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Note" hint={`Plain text, up to 4000 characters (${body.length} used).`} required error={error ?? undefined}>
          <Textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={4000} rows={8} />
        </Field>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            Save note
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Increment 06 (D8): staff waive one task with a reason (kept as an internal note; audited). */
export function WaiveTaskDialog({ orderId, statusKey, target, onClose }: { orderId: string; statusKey: string; target: WaiveTarget; onClose: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation(
    trpc.orders.requirements.waive.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.orders.requirements.forOrder.queryKey({ orderId }) });
        toast.show({ tone: "success", title: "Task waived", description: target.label });
        onClose();
      },
      onError: (failure) => setError(errorMessage(failure)),
    }),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (reason.trim().length < 10) return setError("Give a reason of at least 10 characters.");
    mutation.mutate({ orderId, statusKey, taskKey: target.taskKey, reason: reason.trim() });
  };
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)} title={`Waive “${target.label}”?`} description="The task counts as done for this order. This cannot be undone. The reason is kept as an internal note." dismissible={!mutation.isPending}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Reason" hint="10 to 500 characters. Staff only." required error={error ?? undefined}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={3} />
        </Field>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            Waive task
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
