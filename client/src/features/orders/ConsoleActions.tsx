/** Console-only order administration: lock, reference change, reassignment. Owner: orders_engineer. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { roleHasCapability } from "@shared/capabilities";
import { useSession } from "@/lib/session";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, Card, DateTime, Dialog, Field, Input, Select, StepUpCancelledError, useStepUp, useToast } from "@/ui";
import { LOCK_LABELS, newIdempotencyKey, type LockState } from "./shared";

type Props = { orderId: string; version: number; lockState: LockState; reference: string };

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

export function ConsoleActions({ orderId, version, lockState, reference }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp();
  const { me } = useSession();
  const role = me?.user.role;
  const isAdmin = role === "admin";
  const canManage = role !== undefined && role !== "customer" && roleHasCapability(role, "orders.manage");
  const setLock = useMutation(trpc.orders.admin.setLock.mutationOptions());
  const changeReference = useMutation(trpc.orders.admin.changeReference.mutationOptions());
  const reassign = useMutation(trpc.orders.admin.reassign.mutationOptions());
  const history = useQuery(trpc.orders.admin.referenceHistory.queryOptions({ orderId }));
  const [dialog, setDialog] = useState<"lock" | "reference" | "reassign" | null>(null);
  const [lockTarget, setLockTarget] = useState<LockState>(lockState === "none" ? "review" : "none");
  const [reasonCode, setReasonCode] = useState("");
  const [newReference, setNewReference] = useState("");
  const [targetCustomer, setTargetCustomer] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Stable per dialog opening so a retried reassignment is idempotent on the server.
  const [operationId, setOperationId] = useState(newIdempotencyKey);

  const open = (kind: "lock" | "reference" | "reassign") => {
    setDialog(kind);
    setReasonCode("");
    setError(null);
    setConfirmText("");
    setOperationId(newIdempotencyKey());
  };
  const done = async (title: string) => {
    toast.show({ tone: "success", title });
    setDialog(null);
    await queryClient.invalidateQueries({ queryKey: trpc.orders.pathKey() });
  };
  const run = async (action: () => Promise<unknown>, title: string) => {
    setError(null);
    if (!reasonCode) return setError("Choose a reason.");
    try {
      await action();
      await done(title);
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

  return (
    <Card title="Administration" description="Changes here are audited.">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          {canManage && (isAdmin || !adminOnlyNow) ? (
            <Button variant="secondary" onClick={() => open("lock")}>
              Change lock
            </Button>
          ) : null}
          {isAdmin ? (
            <Button variant="secondary" onClick={() => open("reference")}>
              Change reference
            </Button>
          ) : null}
          {isAdmin ? (
            <Button variant="danger" onClick={() => open("reassign")}>
              Reassign to another customer
            </Button>
          ) : null}
        </div>
        {history.data && history.data.length > 1 ? (
          <div>
            <h3 className="text-sm font-semibold text-ink">Reference history</h3>
            <ul className="mt-1 flex flex-col gap-1 text-sm text-body">
              {history.data.map((entry) => (
                <li key={`${entry.reference}-${entry.status}`} className="flex flex-wrap items-center gap-2">
                  <span className="break-all">{entry.reference}</span>
                  <Badge tone={entry.status === "active" ? "success" : "neutral"}>{entry.status === "active" ? "Current" : "Retired (reserved)"}</Badge>
                  <DateTime value={entry.assignedAt} format="date" />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <Dialog
        open={dialog === "lock"}
        onOpenChange={(value) => (value ? undefined : setDialog(null))}
        title="Change lock"
        description="Locks block changes only; people with access can still view and download."
        footer={
          <Button loading={setLock.isPending} onClick={() => void run(() => setLock.mutateAsync({ orderId, expectedVersion: version, lockState: lockTarget, reasonCode }), "Lock updated")}>
            Apply
          </Button>
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
        onOpenChange={(value) => (value ? undefined : setDialog(null))}
        title="Change order reference"
        description={`The current reference ${reference} will be retired and reserved permanently. It can never be reused.`}
        footer={
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
        onOpenChange={(value) => (value ? undefined : setDialog(null))}
        title="Reassign order"
        description="Ownership moves to the selected customer. Every share is revoked, file ownership moves with the order, and outstanding download links stop working."
        footer={
          <Button
            variant="danger"
            disabled={confirmText.trim() !== reference}
            loading={reassign.isPending}
            onClick={() =>
              void run(
                () =>
                  stepUp.run(() => reassign.mutateAsync({ orderId, targetCustomerPublicId: targetCustomer.trim(), expectedVersion: version, operationId, reasonCode }), {
                    reason: "Reassigning an order needs verification.",
                  }),
                "Order reassigned",
              )
            }
          >
            Reassign order
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
          <Field label="Target customer ID" hint="The customer's account ID from the customer record (26 characters).">
            <Input value={targetCustomer} onChange={(event) => setTargetCustomer(event.target.value)} maxLength={26} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Reason" required>
            <Select options={REASSIGN_REASONS} placeholder="Choose a reason" value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} />
          </Field>
          <Field label={`Type ${reference} to confirm`}>
            <Input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
        </div>
      </Dialog>
    </Card>
  );
}
