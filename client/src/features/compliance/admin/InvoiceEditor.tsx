/** Invoice draft editor (create or update). Amounts entered in major units, sent as integer minor units. Owner: orders_engineer (compliance admin UI). */
import { useMutation } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { useTRPC } from "@/lib/trpc";
import { Button, Callout, Dialog, Field, IconButton, Input, KeyValueList, Money, Textarea } from "@/ui";
import { formatMinorToDecimalInput, parseDecimalToMinor } from "../shared";
import { useGuardedAction } from "./common";
import { CURRENCY, ULID, fromLocalInput, money, toDateInput, type InvoiceDetail } from "./model";

type LineDraft = { id: number; description: string; quantity: string; unitAmount: string };
let lineSeq = 0;
const blankLine = (): LineDraft => ({ id: ++lineSeq, description: "", quantity: "1", unitAmount: "" });
const MAX_UNIT_MINOR = 10_000_000_000;

export const INVOICE_REASON = "Managing invoices needs verification.";

export function InvoiceEditor({ invoice, defaultOrderId, onClose }: { invoice: InvoiceDetail | null; defaultOrderId?: string; onClose: () => void }) {
  const trpc = useTRPC();
  const [, navigate] = useLocation();
  const guarded = useGuardedAction();
  const create = useMutation(trpc.compliance.invoices.admin.createDraft.mutationOptions());
  const update = useMutation(trpc.compliance.invoices.admin.updateDraft.mutationOptions());
  const [orderId, setOrderId] = useState(defaultOrderId ?? "");
  const [currency, setCurrency] = useState(invoice?.currency ?? "USD");
  const [lines, setLines] = useState<LineDraft[]>(() =>
    invoice?.lines.length ? invoice.lines.map((l) => ({ id: ++lineSeq, description: l.description, quantity: String(l.quantity), unitAmount: formatMinorToDecimalInput(l.unitAmountMinor) })) : [blankLine()],
  );
  const [discount, setDiscount] = useState(invoice ? formatMinorToDecimalInput(invoice.discountMinor) : "0");
  const [tax, setTax] = useState(invoice ? formatMinorToDecimalInput(invoice.taxMinor) : "0");
  const [dueAt, setDueAt] = useState(toDateInput(invoice?.dueAt));
  const [memo, setMemo] = useState(invoice?.memo ?? "");
  const [error, setError] = useState<string | null>(null);

  const parsedLines = lines.map((l) => ({ description: l.description.trim(), quantity: Number(l.quantity), unitAmountMinor: parseDecimalToMinor(l.unitAmount) }));
  const subtotal = parsedLines.reduce((sum, l) => (Number.isInteger(l.quantity) && l.unitAmountMinor !== null ? sum + l.quantity * l.unitAmountMinor : sum), 0);
  const discountMinor = parseDecimalToMinor(discount);
  const taxMinor = parseDecimalToMinor(tax);
  const total = subtotal - (discountMinor ?? 0) + (taxMinor ?? 0);
  const validCurrency = CURRENCY.test(currency);

  const setLine = (id: number, patch: Partial<LineDraft>) => setLines((current) => current.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!invoice && !ULID.test(orderId.trim())) return setError("Enter the 26-character order ID.");
    if (!validCurrency) return setError("Enter a three-letter currency code such as USD.");
    for (const [index, l] of parsedLines.entries()) {
      if (!l.description || l.description.length > 240) return setError(`Line ${index + 1}: enter a description of up to 240 characters.`);
      if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 10000) return setError(`Line ${index + 1}: quantity must be a whole number from 1 to 10000.`);
      if (l.unitAmountMinor === null || l.unitAmountMinor > MAX_UNIT_MINOR) return setError(`Line ${index + 1}: enter a unit price such as 125 or 125.50.`);
    }
    if (discountMinor === null || taxMinor === null) return setError("Enter the discount and tax as amounts such as 0 or 12.50.");
    if (total < 0) return setError("The discount cannot exceed the subtotal plus tax.");
    const due = fromLocalInput(dueAt);
    if (dueAt && !due) return setError("Enter a valid due date.");
    setError(null);
    const body = {
      currency,
      lines: parsedLines.map((l) => ({ description: l.description, quantity: l.quantity, unitAmountMinor: l.unitAmountMinor as number })),
      discountMinor,
      taxMinor,
      dueAt: due,
      memo: memo.trim() || null,
    };
    const result = await guarded<{ invoicePublicId: string } | unknown>(
      () => (invoice ? update.mutateAsync({ invoicePublicId: invoice.invoicePublicId, expectedVersion: invoice.version, ...body }) : create.mutateAsync({ orderPublicId: orderId.trim(), ...body })),
      { reason: INVOICE_REASON, success: invoice ? "Draft invoice saved" : "Draft invoice created" },
    );
    if (!result.ok) return setError(result.error);
    onClose();
    if (!invoice) navigate(`/admin/invoices/${(result.value as { invoicePublicId: string }).invoicePublicId}`);
  };

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={invoice ? "Edit draft invoice" : "New draft invoice"}
      description="Drafts are not visible to the customer until issued. Amounts are entered in major units, e.g. 125.50."
      footer={
        <Button loading={create.isPending || update.isPending} onClick={() => void submit()}>
          Save draft
        </Button>
      }
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          {invoice ? null : (
            <Field label="Order ID" required hint="From the order page (26 characters).">
              <Input value={orderId} onChange={(e) => setOrderId(e.target.value)} maxLength={26} autoComplete="off" spellCheck={false} />
            </Field>
          )}
          <Field label="Currency" required>
            <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} autoComplete="off" />
          </Field>
        </div>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-base font-semibold text-ink">Line items</legend>
          <ol className="flex flex-col gap-3">
            {lines.map((l, index) => (
              <li key={l.id} className="grid gap-3 rounded-[var(--radius-card)] border border-line p-3 sm:grid-cols-[1fr_6rem_8rem_auto] sm:items-end">
                <Field label={`Line ${index + 1} description`}>
                  <Input value={l.description} onChange={(e) => setLine(l.id, { description: e.target.value })} maxLength={240} />
                </Field>
                <Field label="Quantity">
                  <Input type="number" inputMode="numeric" min={1} max={10000} value={l.quantity} onChange={(e) => setLine(l.id, { quantity: e.target.value })} />
                </Field>
                <Field label="Unit price">
                  <Input inputMode="decimal" value={l.unitAmount} onChange={(e) => setLine(l.id, { unitAmount: e.target.value })} maxLength={14} />
                </Field>
                <IconButton label={`Remove line ${index + 1}`} icon={<Trash2 aria-hidden />} variant="ghost" disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((x) => x.id !== l.id))} />
              </li>
            ))}
          </ol>
          <div>
            <Button variant="secondary" size="sm" leadingIcon={<Plus aria-hidden />} disabled={lines.length >= 100} onClick={() => setLines((current) => [...current, blankLine()])}>
              Add line
            </Button>
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Discount">
            <Input inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} maxLength={14} />
          </Field>
          <Field label="Tax">
            <Input inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} maxLength={14} />
          </Field>
          <Field label="Due date" hint="Optional.">
            <Input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </Field>
        </div>
        <Field label="Memo" hint="Optional. Printed on the invoice.">
          <Textarea value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={1000} rows={2} />
        </Field>
        {validCurrency ? (
          <div role="status" aria-live="polite">
            <KeyValueList
              columns={2}
              items={[
                { label: "Subtotal", value: <Money value={money(subtotal, currency)} /> },
                { label: "Estimated total", value: <Money value={money(Math.max(0, total), currency)} /> },
              ]}
            />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
