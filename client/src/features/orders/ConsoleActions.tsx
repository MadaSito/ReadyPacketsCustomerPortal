/** Console-only order action row (B1): rename, reference change, reassignment, invoice, refund, lock, access. Owner: orders_engineer. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";
import { roleHasCapability } from "@shared/capabilities";
import { useSession } from "@/lib/session";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, Card, DateTime, Dialog, Field, Input, Select, StepUpCancelledError, useStepUp, useToast } from "@/ui";
import { AccessDialog, CustomerPicker, NewOrderForCustomerDialog, type PickedCustomer } from "./ConsoleOrderTools";
import { LOCK_LABELS, newIdempotencyKey, type LockState } from "./shared";

type Props = { orderId: string; version: number; lockState: LockState; reference: string; name: string };

const LOCK_REASONS = [
  { value: "REVIEW_STARTED", label: "Review started" },
  { value: "WORK_FINALIZED", label: "Work finalized" },
  { value: "LEGAL_REQUEST", label: "Legal request" },
  { value: "CUSTOMER_REQUEST", label: "Customer request" },
  { value: "CORRECTION", label: "Correction" },
];
const REFERENCE_REASONS = [
  { value: "CUSTOMER_REQUEST", label: "Customer request" },
  { value: "CORRECTION", label: "Correction" },
  { value: "MIGRATION", label: "Migration" },
];
const REASSIGN_REASONS = [
  { value: "ACCOUNT_MERGE", label: "Accounts merged" },
  { value: "OWNERSHIP_TRANSFER", label: "Ownership transfer requested" },
  { value: "CORRECTION", label: "Created for the wrong customer" },
];

export function ConsoleActions({ orderId, version, lockState, reference, name }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const { me } = useSession();
  const role = me?.user.role;
  const isAdmin = role === "admin";
  const canManage = role !== undefined && role !== "customer" && roleHasCapability(role, "orders.manage");
  /**
   * Every successful change patches the cached detail immediately (so the header, breadcrumb and summary
   * update without waiting for a refetch) and then invalidates every orders query (detail, list, history).
   */
  const patchDetail = (patch: { version?: number; reference?: string; lockState?: LockState; projectName?: string }) => {
    queryClient.setQueryData(trpc.orders.admin.get.queryKey({ orderId }), (current) => (current ? { ...current, ...patch } : current));
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.orders.pathKey(), refetchType: "all" });
  const setLock = useMutation(
    trpc.orders.admin.setLock.mutationOptions({
      onSuccess: async (result) => {
        patchDetail({ version: result.version, lockState: result.lockState as LockState });
        await refresh();
      },
    }),
  );
  const changeReference = useMutation(
    trpc.orders.admin.changeReference.mutationOptions({
      onSuccess: async (result) => {
        patchDetail({ version: result.version, reference: result.reference });
        await refresh();
      },
    }),
  );
  const reassign = useMutation(trpc.orders.admin.reassign.mutationOptions({ onSuccess: () => refresh() }));
  const rename = useMutation(
    trpc.orders.console.rename.mutationOptions({
      onSuccess: async (result, input) => {
        patchDetail({ version: result.version, projectName: input.name.normalize("NFC").trim() });
        await refresh();
      },
    }),
  );
  const canRename = role !== undefined && role !== "customer" && roleHasCapability(role, "orders.rename");
  const canRefund = role !== undefined && role !== "customer" && roleHasCapability(role, "payments.refund");
  const [newName, setNewName] = useState(name);
  const [dialog, setDialog] = useState<"lock" | "reference" | "reassign" | "rename" | null>(null);
  const [lockTarget, setLockTarget] = useState<LockState>(lockState === "none" ? "review" : "none");
  const [reasonCode, setReasonCode] = useState("");
  const [newReference, setNewReference] = useState("");
  const [targetCustomer, setTargetCustomer] = useState<PickedCustomer | null>(null);
  const [panel, setPanel] = useState<"access" | "new" | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Stable per dialog opening so a retried reassignment is idempotent on the server.
  const [operationId, setOperationId] = useState(newIdempotencyKey);

  const submitRename = async () => {
    setError(null);
    const value = newName.normalize("NFC").trim();
    if (!value) return setError("Enter a name for the order.");
    if (value === name) return setDialog(null);
    try {
      await rename.mutateAsync({ orderId, expectedVersion: version, name: value });
      done("Order renamed");
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const open = (kind: "lock" | "reference" | "reassign" | "rename") => {
    setDialog(kind);
    setNewName(name);
    setReasonCode("");
    setError(null);
    setConfirmText("");
    setTargetCustomer(null);
    setOperationId(newIdempotencyKey());
  };
  const done = (title: string) => {
    toast.show({ tone: "success", title });
    setDialog(null);
  };
  const busy = setLock.isPending || changeReference.isPending || reassign.isPending || rename.isPending;
  const close = () => {
    if (!busy) setDialog(null);
  };
  const cancelButton = (
    <Button variant="secondary" onClick={close} disabled={busy}>
      Cancel
    </Button>
  );
  const run = async (action: () => Promise<unknown>, title: string) => {
    setError(null);
    if (!reasonCode) return setError("Choose a reason.");
    try {
      await action();
      done(title);
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      setError(errorMessage(err));
    }
  };

  const lockOptions = (Object.keys(LOCK_LABELS) as LockState[])
    .filter((state) => state !== lockState)
    .filter((state) => isAdmin || (state !== "legal_hold" && state !== "imported_read_only"))
    .map((state) => ({ value: state, label: LOCK_LABELS[state] }));
  const adminOnlyNow = lockState === "legal_hold" || lockState === "imported_read_only";

  const base = `/admin/orders/${orderId}`;
  return (
    <>
      {/* B1 action row: Rename order, Change reference, Reassign customer, Invoice, Refund, then the extras. */}
      <div role="group" aria-label="Order actions" className="flex flex-wrap gap-2">
        {canRename ? (
          <Button variant="secondary" onClick={() => open("rename")}>
            Rename order
          </Button>
        ) : null}
        {isAdmin ? (
          <Button variant="secondary" onClick={() => open("reference")}>
            Change reference
          </Button>
        ) : null}
        {isAdmin ? (
          <Button variant="secondary" onClick={() => open("reassign")}>
            Reassign customer
          </Button>
        ) : null}
        <Button variant="secondary" asChild>
          <Link href={`${base}/invoices`}>Invoice</Link>
        </Button>
        {canRefund ? (
          <Button variant="danger" asChild>
            <Link href={`${base}/refund`}>Refund</Link>
          </Button>
        ) : null}
        {canManage && (isAdmin || !adminOnlyNow) ? (
          <Button variant="secondary" onClick={() => open("lock")}>
            Change lock
          </Button>
        ) : null}
        <Button variant="secondary" onClick={() => setPanel("access")}>
          Access for other users
        </Button>
        {canManage ? (
          <Button variant="secondary" onClick={() => setPanel("new")}>
            New order for a customer
          </Button>
        ) : null}
      </div>

      <Dialog
        open={dialog === "rename"}
        onOpenChange={(value) => (value ? undefined : close())}
        title="Rename order"
        description={`The reference ${reference} does not change. The rename is recorded in the order history.`}
        footer={
          <>
            {cancelButton}
            <Button loading={rename.isPending} onClick={() => void submitRename()}>
              Save name
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submitRename();
          }}
        >
          {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
          <Field label="Order name" required hint="1 to 120 characters.">
            <Input value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={120} autoComplete="off" />
          </Field>
        </form>
      </Dialog>

      <Dialog
        open={dialog === "lock"}
        onOpenChange={(value) => (value ? undefined : close())}
        title="Change lock"
        description="Locks block changes only; people with access can still view and download."
        footer={
          <>
            {cancelButton}
          <Button loading={setLock.isPending} onClick={() => void run(() => setLock.mutateAsync({ orderId, expectedVersion: version, lockState: lockTarget, reasonCode }), "Lock updated")}>
            Apply
          </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
          <Field label="New lock state">
            <Select options={lockOptions} value={lockTarget} onChange={(event) => setLockTarget(event.target.value as LockState)} />
          </Field>
          <Field label="Reason" required>
            <Select options={LOCK_REASONS} placeholder="Choose a reason" value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={dialog === "reference"}
        onOpenChange={(value) => (value ? undefined : close())}
        title="Change order reference"
        description={`The current reference ${reference} will be retired and reserved permanently. It can never be reused.`}
        footer={
          <>
            {cancelButton}
          <Button
            loading={changeReference.isPending}
            onClick={() =>
              void run(
                () => stepUp.run(() => changeReference.mutateAsync({ orderId, expectedVersion: version, newReference: newReference.trim(), reasonCode }), { reason: "Changing an order reference needs verification." }),
                "Reference changed",
              )
            }
          >
            Change reference
          </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
          <Field label="New reference" hint="Letters, digits and hyphens.">
            <Input value={newReference} onChange={(event) => setNewReference(event.target.value)} maxLength={32} autoComplete="off" />
          </Field>
          <Field label="Reason" required>
            <Select options={REFERENCE_REASONS} placeholder="Choose a reason" value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={dialog === "reassign"}
        onOpenChange={(value) => (value ? undefined : close())}
        title="Reassign order"
        description="Ownership moves to the selected customer. Every share is revoked, file ownership moves with the order, and outstanding download links stop working."
        footer={
          <>
            {cancelButton}
          <Button
            variant="danger"
            disabled={confirmText.trim() !== reference || !targetCustomer}
            loading={reassign.isPending}
            onClick={() =>
              void run(
                () =>
                  stepUp.run(() => reassign.mutateAsync({ orderId, targetCustomerPublicId: targetCustomer?.publicId ?? "", expectedVersion: version, operationId, reasonCode }), {
                    reason: "Reassigning an order needs verification.",
                  }),
                "Order reassigned",
              )
            }
          >
            Reassign order
          </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
          <CustomerPicker label="New owner" value={targetCustomer} onChange={setTargetCustomer} />
          <Field label="Reason" required>
            <Select options={REASSIGN_REASONS} placeholder="Choose a reason" value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} />
          </Field>
          <Field label={`Type ${reference} to confirm`}>
            <Input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
        </div>
      </Dialog>
      <AccessDialog open={panel === "access"} onClose={() => setPanel(null)} scope={{ orderId }} subject={reference} />
      {canManage ? <NewOrderForCustomerDialog open={panel === "new"} onClose={() => setPanel(null)} /> : null}
    </>
  );
}

/** Console: retired references stay reserved forever; shown on the Overview tab when there is more than one. */
export function ReferenceHistory({ orderId }: { orderId: string }) {
  const trpc = useTRPC();
  const history = useQuery(trpc.orders.admin.referenceHistory.queryOptions({ orderId }));
  if (!history.data || history.data.length <= 1) return null;
  return (
    <Card title="Reference history">
      <ul className="flex flex-col gap-1 text-sm text-body">
        {history.data.map((entry) => (
          <li key={`${entry.reference}-${entry.status}`} className="flex flex-wrap items-center gap-2">
            <span className="break-all">{entry.reference}</span>
            <Badge tone={entry.status === "active" ? "success" : "neutral"}>{entry.status === "active" ? "Current" : "Retired (reserved)"}</Badge>
            <DateTime value={entry.assignedAt} format="date" />
          </li>
        ))}
      </ul>
    </Card>
  );
}
