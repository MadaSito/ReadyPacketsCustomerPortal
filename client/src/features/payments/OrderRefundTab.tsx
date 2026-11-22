import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { formatMinorToDecimalInput, parseDecimalToMinor } from "@/lib/moneyInput";
import { safeError, useTRPC, useTRPCClient } from "@/lib/trpc";
import {
  Badge, Button, Callout, Card, Checkbox, ConfirmDialog, DataTable, DateTime, EmptyState, ErrorState, Field,
  Input, Money, Skeleton, StepUpCancelledError, Textarea, useStepUp,
} from "@/ui";

type Status = "pending" | "succeeded" | "failed" | "unknown";
type ExecutionKind = "provider_refund" | "recorded_only";
type Provider = "manual" | "stripe" | "square";
type Result = { status: Status; executionKind: ExecutionKind };
interface Refund {
  refundPublicId: string;
  status: Status;
  executionKind: ExecutionKind;
  amountMinor: number;
  currency: string;
  createdAt: string;
  reason?: string | null;
}
interface Payment {
  paymentPublicId: string;
  invoiceNumber: string;
  provider: Provider;
  executionKind: ExecutionKind;
  capturedMinor: number;
  refundedMinor: number;
  refundableMinor: number;
  reservedPendingOrUnknownMinor: number;
  currency: string;
  refunds: readonly Refund[];
}
interface InputValues {
  paymentPublicId: string;
  amountMinor: number;
  currency: string;
  reason: string;
  sendCustomerNotice: boolean;
  confirmationPhrase: "REFUND ORDER";
  idempotencyKey: string;
}
const providers: Record<Provider, string> = { square: "Square", stripe: "Stripe", manual: "Manual" };
const states = {
  succeeded: { label: "Succeeded", tone: "success", detail: "The payment provider confirmed the refund." },
  pending: { label: "Pending", tone: "info", detail: "The payment provider is still processing the refund. Check the history for updates before sending another refund." },
  failed: { label: "Failed", tone: "danger", detail: "The refund was not completed. Review the payment and refund history before taking another action." },
  unknown: { label: "Outcome unknown", tone: "warning", detail: "Do not send another refund for this payment. Check the provider dashboard and review the refund history for updates." },
  recorded: { label: "Recorded only", tone: "neutral", detail: "No money was moved by the portal." },
} as const;
const display = (result: Result) => states[result.status === "succeeded" && result.executionKind === "recorded_only" ? "recorded" : result.status];
const money = (amountMinor: number, currency: string) => <Money value={{ amountMinor, currency }} />;
const hasUnknown = (payment: Payment) => payment.refunds.some(({ status }) => status === "unknown");

function RefundDialog({ payment, submit, close, finish }: {
  payment: Payment; submit: (values: InputValues) => Promise<Result>; close: () => void; finish: (result: Result) => void;
}) {
  const manual = payment.executionKind === "recorded_only";
  const fullAmount = formatMinorToDecimalInput(payment.refundableMinor, payment.currency);
  const [amount, setAmount] = useState(fullAmount);
  const [reason, setReason] = useState("");
  const [sendCustomerNotice, setSendCustomerNotice] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [idempotencyKey] = useState(() => `order-refund:${crypto.randomUUID()}`);
  const amountMinor = parseDecimalToMinor(amount, false, payment.currency);
  const validAmount = amountMinor !== null && amountMinor <= payment.refundableMinor;
  return <ConfirmDialog open onOpenChange={(open) => { if (!open) close(); }} destructive confirmText="REFUND ORDER"
    title={manual ? "Record refund" : "Prepare refund"} confirmLabel={manual ? "Record refund" : "Send refund"}
    description={manual ? "Use this only for a refund handled outside ReadyPackets." :
      `${providers[payment.provider]} will be asked to return this amount to the original payment method.`}
    onConfirm={async () => {
      setProblem(undefined);
      if (!validAmount || !reason.trim()) {
        const message = amountMinor === null ? `Enter a positive ${payment.currency} amount with valid decimal places.`
          : !validAmount ? "Enter an amount no higher than the refundable balance." : "Enter a refund reason.";
        setProblem(message);
        throw new Error(message);
      }
      try {
        finish(await submit({ paymentPublicId: payment.paymentPublicId, amountMinor, currency: payment.currency, reason: reason.trim(),
          sendCustomerNotice, confirmationPhrase: "REFUND ORDER", idempotencyKey }));
      } catch (error) {
        if (error instanceof StepUpCancelledError) {
          setProblem("Verification was cancelled. No refund was submitted.");
          throw error;
        }
        const refusal = safeError(error);
        if (refusal && (["BAD_INPUT", "VALIDATION", "FORBIDDEN", "NOT_FOUND", "STEP_UP_REQUIRED"].includes(refusal.domainCode) ||
          (refusal.domainCode === "CONFLICT" && refusal.reasonCode === "REFUND_EXCEEDS_REFUNDABLE"))) {
          setProblem(refusal.safeMessage);
          throw error;
        }
        // A lost mutation response is not evidence the server did nothing. Close the form and block
        // a fresh attempt for this payment rather than letting it mint another idempotency key.
        finish({ status: "unknown", executionKind: payment.executionKind });
      }
    }}>
    <div className="grid gap-3">
      {manual ? <Callout tone="info" title="Recorded only">No money is moved by the portal.</Callout> : null}
      <Field label={`Amount (${payment.currency})`} hint={<>Up to {money(payment.refundableMinor, payment.currency)}</>} required>
        <Input inputMode="decimal" autoComplete="off" maxLength={20} value={amount} onChange={(event) => setAmount(event.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => setAmount(fullAmount)}>Use full refundable balance</Button>
        {validAmount ? <span>Amount: {money(amountMinor, payment.currency)}</span> : null}
      </div>
      <Field label="Refund reason" hint="Do not include card details." required>
        <Textarea rows={3} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <Checkbox label="Email the customer when the refund is confirmed" checked={sendCustomerNotice} onCheckedChange={setSendCustomerNotice} />
      {problem ? <Callout tone="danger" live="assertive" title="Cannot submit refund">{problem}</Callout> : null}
    </div>
  </ConfirmDialog>;
}

export function OrderRefundPanel({ payments, canIssueRefund, submit }: {
  payments: readonly Payment[]; canIssueRefund: boolean; submit: (values: InputValues) => Promise<Result>;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const [result, setResult] = useState<Result>();
  const [blocked, setBlocked] = useState<ReadonlySet<string>>(() => new Set());
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!result || selectedId) return;
    // The row action can disappear after submission. Wait for the modal's focus trap to release.
    const frame = window.requestAnimationFrame(() => resultRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [result, selectedId]);
  const selected = canIssueRefund ? payments.find(({ paymentPublicId }) => paymentPublicId === selectedId) : undefined;
  const feedback = result ? display(result) : undefined;
  return <div className="grid min-w-0 gap-5">
    {!canIssueRefund ? <Callout tone="info" title="Read-only refund history">You can review balances and past refunds. A user with refund permission must prepare or record refunds.</Callout> : null}
    {feedback ? <div role="group" aria-label={`Refund result: ${feedback.label}`} tabIndex={-1} ref={resultRef}>
      <Callout tone={feedback.tone === "neutral" ? "info" : feedback.tone} title={feedback.label} live="polite">{feedback.detail}</Callout>
    </div> : null}
    <Card title="Payments and refundable balances" description="Pending or unconfirmed refunds reduce the balance available for another refund.">
      <DataTable caption="Order payments" rows={payments} rowKey={(payment) => payment.paymentPublicId}
        empty={<EmptyState title="No captured payments" description="Payments appear here after they are captured or recorded." />}
        columns={[
          { key: "provider", header: "Payment", primary: true, cell: (payment) => <div>
            <p>{providers[payment.provider]} <span className="break-all text-muted">{payment.invoiceNumber}</span></p>
            <p className="break-all font-mono text-xs text-muted">{payment.paymentPublicId}</p>
          </div> },
          { key: "captured", header: "Captured", align: "end", cell: (payment) => money(payment.capturedMinor, payment.currency) },
          { key: "refunded", header: "Refunded", align: "end", cell: (payment) => money(payment.refundedMinor, payment.currency) },
          { key: "reserved", header: "Reserved", align: "end", cell: (payment) => money(payment.reservedPendingOrUnknownMinor, payment.currency) },
          { key: "refundable", header: "Refundable", align: "end", cell: (payment) => money(payment.refundableMinor, payment.currency) },
        ]}
        rowActions={canIssueRefund ? (payment) => hasUnknown(payment) || blocked.has(payment.paymentPublicId) ?
          <span className="text-sm text-muted">Confirm prior outcome first</span> : payment.refundableMinor > 0 ?
            <Button variant={payment.executionKind === "recorded_only" ? "secondary" : "danger"} size="sm"
              aria-label={`${payment.executionKind === "recorded_only" ? "Record" : "Prepare"} refund for ${providers[payment.provider]} payment ${payment.paymentPublicId}`}
              onClick={() => { setResult(undefined); setSelectedId(payment.paymentPublicId); }}>
              {payment.executionKind === "recorded_only" ? "Record refund" : "Prepare refund"}
            </Button> : null : undefined} />
    </Card>
    <Card title="Refund history" description="A pending or unknown state is not evidence that money was returned.">
      <DataTable caption="Order refunds" rows={payments.flatMap((payment) => payment.refunds.map((refund) => ({ ...refund, payment })))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))} rowKey={(refund) => refund.refundPublicId}
        empty={<EmptyState title="No refunds yet" description="Recorded refunds and provider attempts appear here." />}
        columns={[
          { key: "refund", header: "Refund", primary: true, cell: (refund) => <div>
            <p>{providers[refund.payment.provider]} <span className="break-all text-muted">{refund.payment.invoiceNumber}</span></p>
            <p className="break-all font-mono text-xs text-muted">{refund.refundPublicId}</p>
            {refund.reason ? <p className="break-words">{refund.reason}</p> : null}
          </div> },
          { key: "state", header: "Status", cell: (refund) => <Badge tone={display(refund).tone}>{display(refund).label}</Badge> },
          { key: "amount", header: "Amount", align: "end", cell: (refund) => money(refund.amountMinor, refund.currency) },
          { key: "created", header: "Prepared", cell: (refund) => <DateTime value={refund.createdAt} /> },
        ]} />
    </Card>
    {selected ? <RefundDialog key={selected.paymentPublicId} payment={selected} submit={submit}
      close={() => setSelectedId(undefined)} finish={(value) => {
        if (value.status === "unknown") setBlocked((prior) => new Set(prior).add(selected.paymentPublicId));
        setResult(value);
      }} /> : null}
  </div>;
}

function RefundWorkspace({ orderId }: { orderId: string }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const cache = useQueryClient();
  const stepUp = useStepUp();
  const order = { orderPublicId: orderId };
  const workspace = useQuery(trpc.payments.refunds.forOrder.queryOptions(order, {
    refetchInterval: (query) => query.state.data?.payments.some((payment) => payment.reservedPendingOrUnknownMinor > 0) ? 15_000 : false,
  }));
  if (!workspace.data) return workspace.isPending ? <div role="status" aria-label="Loading refunds"><Skeleton lines={5} /></div> :
    <ErrorState title="Could not load refunds" error={workspace.error} onRetry={() => { void workspace.refetch(); }} />;
  return <OrderRefundPanel key={orderId} payments={workspace.data.payments} canIssueRefund={workspace.data.canIssueRefund}
    submit={async (values) => {
      try {
        return await stepUp.run(() => client.payments.refunds.create.mutate({ ...order, ...values }),
          { reason: "A recent identity check is required to submit a refund." });
      } finally {
        void cache.invalidateQueries({ queryKey: trpc.payments.refunds.forOrder.queryKey(order) });
      }
    }} />;
}

export default function OrderRefundTab({ orderId, area }: { orderId: string; area: "console" | "customer" }) {
  return area === "console" ? <RefundWorkspace orderId={orderId} /> : null;
}
