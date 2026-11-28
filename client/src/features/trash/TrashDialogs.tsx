/**
 * Trash confirmations (increment 09 D2.3, D2.6, D2.8). Owner: audit_engineer.
 *  - `MoveToTrashDialog` (exported for the order and customer pages): names the item, what moves with it (server
 *    `summarize`), the date it will be deleted permanently, optional reason ≤ 200; afterwards a toast with Undo.
 *  - `RestoreDialog`: names the item(s) and what returns; confirm only (no step-up).
 *  - `PurgeDialog`: step-up, the typed order number / customer ID (bulk: `DELETE <count>`) which the server checks
 *    again, the lists of what is erased, kept and not touched, "cannot be undone", backups.
 * All are alert dialogs built on `ConfirmDialog`: focus trapped, Esc cancels, focus returns to the trigger, Cancel
 * is focused first for destructive actions, and the outcome is announced (toast + the page's live region).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { safeError, useTRPCClient } from "@/lib/trpc";
import { Callout, ConfirmDialog, Field, Skeleton, Textarea, useStepUp, useToast, type ToastInput } from "@/ui";
import { useTrashApi, type TrashItemRef, type TrashKind } from "./api";
import {
  ERASED, KEPT, KIND_NOUN, NOT_TOUCHED, PURGE_WARNING, bulkConfirmation, countNoun, dueText, newIdempotencyKey, resultSentence, summaryLines,
  trashErrorMessage,
} from "./model";

export const REASON_MAX = 200;

function ErrorLine({ message }: { message: string | null }) {
  // Always mounted and exposed (never display:none) so the first message is announced; spacing only on content.
  return <div role="alert">{message ? <Callout tone="danger" className="mt-3">{message}</Callout> : null}</div>;
}

function SummaryList({ lines, label }: { lines: readonly string[]; label: string }) {
  if (!lines.length) return null;
  return (
    <ul aria-label={label} className="mt-2 list-disc space-y-1 pl-5 [overflow-wrap:anywhere]">
      {lines.map((l) => <li key={l}>{l}</li>)}
    </ul>
  );
}

/** Invalidate every trash read (list, counts, settings) after a change. */
function useRefreshTrash() {
  const api = useTrashApi();
  const client = useQueryClient();
  return () => Promise.all([api.list, api.counts, api.settings.get, api.summarize].map((p) => client.invalidateQueries(p.pathFilter())));
}


export interface MoveToTrashDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: TrashKind;
  publicId: string;
  /** How the page names the item, e.g. "RP-1042 · Ice Queen" or "RPCUS-A1B2CJJG5" (never an e-mail address). */
  itemLabel: string;
  /** After a successful move (the host usually returns to its list). */
  onMoved?: (result: { batchId: string; dueAt: string | Date | null; cascadedOrders: number }) => void;
  /** After Undo restored the item. */
  onRestored?: () => void;
  /**
   * Optional focus target after a successful move (e.g. the list heading when the row disappears) and after Undo
   * (the toast button goes away). Unset: focus returns to the opener; on cancel or failure it always does.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/** Move one order or one suspended customer account to the trash. Import from `@/features/trash/TrashDialogs`. */
export function MoveToTrashDialog({ open, onOpenChange, kind, publicId, itemLabel, onMoved, onRestored, returnFocusRef }: MoveToTrashDialogProps) {
  const api = useTrashApi();
  const toast = useToast();
  const refresh = useRefreshTrash();
  const trpcClient = useTRPCClient();
  const summary = useQuery({ ...api.summarize.queryOptions({ kind, publicId }), enabled: open });
  const move = useMutation(api.moveToTrash.mutationOptions());
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(newIdempotencyKey);
  const noun = KIND_NOUN[kind].one;
  const tooLong = reason.length > REASON_MAX;
  /** The success toast waits until the modal is gone: while it is open the toast live region is hidden. */
  const pendingToast = useRef<ToastInput | null>(null);
  const successFocus = useRef<HTMLElement | null>(null);
  const flushToast = useCallback(() => {
    const input = pendingToast.current;
    pendingToast.current = null;
    if (input) setTimeout(() => toast.show(input), 0);
  }, [toast]);
  // The host may unmount the dialog in onMoved (navigating away): show the toast then too.
  useEffect(() => flushToast, [flushToast]);
  useEffect(() => { if (open) successFocus.current = null; }, [open]);

  const undo = async (batchId: string) => {
    // The Undo button leaves with its toast: right after dismissal, keep keyboard focus somewhere meaningful.
    setTimeout(() => {
      const target = returnFocusRef?.current;
      if (target?.isConnected && (document.activeElement === document.body || !document.activeElement)) target.focus();
    }, 0);
    try {
      const out = await trpcClient.trash.restore.mutate({ items: [{ kind, publicId, batchId }], idempotencyKey: newIdempotencyKey() });
      const failed = out.results.find((r) => !r.ok);
      if (failed) toast.show({ tone: "danger", title: "Not restored", description: trashErrorMessage(failed.reasonCode, failed.safeMessage) });
      else {
        toast.show({ tone: "success", title: "Restored", description: `${itemLabel} is back.` });
        onRestored?.();
      }
    } catch (e) {
      const safe = safeError(e);
      toast.show({ tone: "danger", title: "Not restored", description: trashErrorMessage(safe?.reasonCode, safe?.safeMessage) });
    }
    await refresh();
  };

  const confirm = async () => {
    if (tooLong) throw new Error("reason");
    setError(null);
    try {
      const out = await move.mutateAsync({ kind, publicId, reason: reason.trim() || undefined, idempotencyKey: key });
      setReason("");
      pendingToast.current = {
        tone: "success",
        title: "Moved to trash",
        description: `${itemLabel}. ${out.dueAt ? `It will be deleted permanently on ${dueText(out.dueAt)}.` : `${KEPT_SENTENCE}`}`,
        action: { label: "Undo", onClick: () => void undo(out.batchId) },
      };
      successFocus.current = returnFocusRef?.current ?? null;
      await refresh();
      onMoved?.(out);
    } catch (e) {
      const safe = safeError(e);
      setError(trashErrorMessage(safe?.reasonCode, safe?.safeMessage));
      throw e;
    }
  };

  const lines = summary.data ? summaryLines(summary.data.counts) : [];
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) { setError(null); flushToast(); }
        onOpenChange(next);
      }}
      title={<Wrap>{`Move ${itemLabel} to the trash?`}</Wrap>}
      description={`You can restore the ${noun} from the Trash centre until it is deleted permanently.`}
      confirmLabel="Move to trash"
      destructive
      returnFocusRef={successFocus}
      onConfirm={confirm}
    >
      {summary.isPending ? (
        <div role="status" aria-label="Loading what moves with it"><Skeleton lines={2} /></div>
      ) : summary.data ? (
        <>
          {lines.length ? <p>Moves with it:</p> : <p>Nothing else moves with it.</p>}
          <SummaryList lines={lines} label="What moves with it" />
          <p className="mt-3">
            {summary.data.dueAt ? <>It will be deleted permanently on <strong>{dueText(summary.data.dueAt)}</strong> under the current retention setting.</> : <>{KEPT_SENTENCE}</>}
          </p>
          {summary.data.cascadedOrders > 0 ? (
            <p className="mt-3">{countNoun("order", summary.data.cascadedOrders)} of this customer {summary.data.cascadedOrders === 1 ? "moves" : "move"} to the trash with the account and {summary.data.cascadedOrders === 1 ? "is" : "are"} restored with it.</p>
          ) : null}
          {summary.data.hasPayments ? (
            <p className="mt-3">Moving to the trash never refunds anything. Paid invoices and receipts stay available; open checkout attempts are cancelled.</p>
          ) : null}
        </>
      ) : (
        <Callout tone="warning">We couldn&apos;t load what moves with it. The server still checks everything when you confirm.</Callout>
      )}
      <div className="mt-4">
        <Field label="Reason (optional)" hint={`Up to ${REASON_MAX} characters. Shown in the Trash centre and the audit log.`} error={tooLong ? `Use ${REASON_MAX} characters or fewer.` : undefined}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={REASON_MAX + 50} />
        </Field>
      </div>
      <ErrorLine message={error} />
    </ConfirmDialog>
  );
}

const KEPT_SENTENCE = "Automatic clean-up is off, so it is kept until an administrator deletes it.";

export interface TrashTarget extends TrashItemRef {
  label: string;
  reference: string;
  /** Failed run to finish (EXTERNAL_COPIES_UNREACHABLE) and its unreachable copy count. */
  runId?: string;
  copies?: number;
  /** Halted cascade: the order the run stopped on, and the order number to type for it. */
  targetOrderPublicId?: string;
  targetReference?: string;
}
/** Item labels are free text (project names): let long unbroken words wrap at 240 px in titles and descriptions. */
function Wrap({ children }: { children: ReactNode }) {
  return <span className="[overflow-wrap:anywhere]">{children}</span>;
}
const labelsOf = (items: readonly TrashTarget[]): Map<string, string> => new Map(items.map((i) => [i.publicId, i.label]));

/** Restore one or more items (confirm only; the server reports per item). */
export function RestoreDialog({ open, onOpenChange, kind, items, onDone, returnFocusRef }: {
  open: boolean; onOpenChange: (open: boolean) => void; kind: TrashKind; items: readonly TrashTarget[]; onDone: (sentence: string) => void;
  /** Set by the caller on success (the opener row is gone); unset = focus returns to the opener. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const api = useTrashApi();
  const refresh = useRefreshTrash();
  const restore = useMutation(api.restore.mutationOptions());
  const single = items.length === 1 ? items[0]! : null;
  const summary = useQuery({ ...api.summarize.queryOptions({ kind, publicId: single?.publicId ?? "" }), enabled: open && Boolean(single) });
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);
  const lines = summary.data ? summaryLines(summary.data.counts) : [];

  const confirm = async () => {
    setError(null);
    try {
      const out = await restore.mutateAsync({ items: items.map(({ kind: k, publicId, batchId }) => ({ kind: k, publicId, batchId })), idempotencyKey: key });
      setKey(newIdempotencyKey());
      await refresh();
      onDone(resultSentence(kind, "restored", out.results, labelsOf(items)));
    } catch (e) {
      const safe = safeError(e);
      setError(trashErrorMessage(safe?.reasonCode, safe?.safeMessage));
      throw e;
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => { if (!next) setError(null); onOpenChange(next); }}
      title={<Wrap>{single ? `Restore ${single.label}?` : `Restore ${countNoun(kind, items.length)}?`}</Wrap>}
      description={kind === "customer"
        ? "The account comes back suspended; reactivate it separately. The orders moved with it come back too."
        : "The order comes back exactly as it was before it was moved to the trash."}
      confirmLabel="Restore"
      returnFocusRef={returnFocusRef}
      onConfirm={confirm}
    >
      {single && summary.data && lines.length ? (<><p>Returns with it:</p><SummaryList lines={lines} label="What returns with it" /></>) : null}
      {!single ? <SummaryList lines={items.map((i) => i.label)} label="Items to restore" /> : null}
      <ErrorLine message={error} />
    </ConfirmDialog>
  );
}

/** Delete permanently (step-up + typed confirmation, checked again by the server). */
export function PurgeDialog({ open, onOpenChange, kind, items, onDone, returnFocusRef }: {
  open: boolean; onOpenChange: (open: boolean) => void; kind: TrashKind; items: readonly TrashTarget[]; onDone: (sentence: string) => void;
  /** Set by the caller on success (the opener row is gone); unset = focus returns to the opener. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const api = useTrashApi();
  const stepUp = useStepUp();
  const refresh = useRefreshTrash();
  const purge = useMutation(api.purge.mutationOptions());
  const single = items.length === 1 ? items[0]! : null;
  const confirmation = single ? single.reference : bulkConfirmation(items.length);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);

  const confirm = async () => {
    setError(null);
    try {
      const out = await stepUp.run(
        () => purge.mutateAsync({ items: items.map(({ kind: k, publicId, batchId }) => ({ kind: k, publicId, batchId })), confirmation, idempotencyKey: key }),
        { reason: "Deleting permanently requires a fresh identity check." },
      );
      setKey(newIdempotencyKey());
      await refresh();
      onDone(resultSentence(kind, "deleted permanently", out.results, labelsOf(items)));
    } catch (e) {
      const safe = safeError(e);
      setError(safe ? trashErrorMessage(safe.reasonCode, safe.safeMessage) : "Identity check cancelled. Nothing was deleted.");
      throw e;
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => { if (!next) setError(null); onOpenChange(next); }}
      title={<Wrap>{single ? `Delete ${single.label} permanently?` : `Delete ${countNoun(kind, items.length)} permanently?`}</Wrap>}
      description={PURGE_WARNING}
      confirmLabel="Delete permanently"
      destructive
      confirmText={confirmation}
      returnFocusRef={returnFocusRef}
      onConfirm={confirm}
    >
      {!single ? <SummaryList lines={items.map((i) => i.label)} label="Items to delete permanently" /> : null}
      <h3 className="mt-3 font-semibold text-ink">Erased</h3>
      <SummaryList lines={ERASED[kind]} label="Erased" />
      <h3 className="mt-3 font-semibold text-ink">Kept, with no way back to a live record</h3>
      <SummaryList lines={KEPT} label="Kept" />
      <p className="mt-2">Unpaid and draft invoices are voided; their numbers are never reused.</p>
      <h3 className="mt-3 font-semibold text-ink">Not touched</h3>
      <SummaryList lines={NOT_TOUCHED} label="Not touched" />
      <ErrorLine message={error} />
    </ConfirmDialog>
  );
}

/**
 * Lead ruling (B): a purge run stopped with EXTERNAL_COPIES_UNREACHABLE. The administrator may finish it and leave
 * the unreachable copies in place — same strength as a permanent deletion (trash.purge, step-up, typed reference).
 * The clean-up job never makes this choice.
 */
export function FinishLeavingCopiesDialog({ open, onOpenChange, item, onDone, returnFocusRef }: {
  open: boolean; onOpenChange: (open: boolean) => void; item: TrashTarget | null; onDone: (sentence: string) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const api = useTrashApi();
  const stepUp = useStepUp();
  const refresh = useRefreshTrash();
  const finish = useMutation(api.finishLeavingExternalCopies.mutationOptions());
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);
  const n = item?.copies ?? 0;
  const copies = n === 1 ? "1 external copy" : `${n} external copies`;
  /** A halted cascade asks for the order the run stopped on; otherwise the item's own reference. */
  const typed = item?.targetReference ?? item?.reference ?? "";

  const confirm = async () => {
    if (!item?.runId || !item.batchId) return;
    const { runId, batchId } = item;
    setError(null);
    try {
      const out = await stepUp.run(
        () => finish.mutateAsync({
          kind: item.kind, publicId: item.publicId, batchId, runId, confirmation: typed, idempotencyKey: key,
          ...(item.targetOrderPublicId ? { targetOrderPublicId: item.targetOrderPublicId } : {}),
        }),
        { reason: "Finishing a permanent deletion requires a fresh identity check." },
      );
      setKey(newIdempotencyKey());
      await refresh();
      onDone(`${item.label} deleted permanently. ${out.keptExternalCopies === 1 ? "1 external copy was" : `${out.keptExternalCopies} external copies were`} left in place.`);
    } catch (e) {
      const safe = safeError(e);
      setError(safe ? trashErrorMessage(safe.reasonCode, safe.safeMessage) : "Identity check cancelled. Nothing was deleted.");
      throw e;
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => { if (!next) setError(null); onOpenChange(next); }}
      title={<Wrap>{item ? `Finish deleting ${item.label} and leave ${copies} in place?` : "Finish the deletion?"}</Wrap>}
      description={`${copies === "1 external copy" ? "1 copy" : `${n} copies`} in a connected storage service could not be reached. If you finish now, the portal erases everything else and forgets where ${n === 1 ? "that copy is" : "those copies are"}; ${n === 1 ? "it stays" : "they stay"} in that service until someone deletes ${n === 1 ? "it" : "them"} there. This cannot be undone.`}
      confirmLabel={`Finish and leave ${copies} in place`}
      destructive
      confirmText={typed}
      returnFocusRef={returnFocusRef}
      onConfirm={confirm}
    >
      {item?.targetReference && item.targetReference !== item.reference ? (
        <p className="[overflow-wrap:anywhere]">The deletion stopped on order <strong>{item.targetReference}</strong>, which was moved to the trash with this item. Type that order number to finish.</p>
      ) : null}
      <p>To delete the copies too, reconnect the storage service instead; the next clean-up retries them.</p>
      <h3 className="mt-3 font-semibold text-ink">Kept</h3>
      <SummaryList lines={[`${copies} in the connected storage service (reported as kept)`, ...KEPT]} label="Kept" />
      <ErrorLine message={error} />
    </ConfirmDialog>
  );
}
