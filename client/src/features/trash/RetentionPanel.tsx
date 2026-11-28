/**
 * Retention clean-up settings and the last run (increment 09 D2.4, D2.8). Owner: audit_engineer.
 * Saving needs step-up. Turning automatic clean-up on, or shortening a period, first shows the server-computed
 * number of items that become due and needs the typed confirmation; the write is a compare-and-set on the
 * settings version and that count (changed meanwhile → "Review again").
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { safeError } from "@/lib/trpc";
import { Button, Callout, Card, ConfirmDialog, DateTime, Field, Input, Skeleton, Switch, useStepUp } from "@/ui";
import { useTrashApi, type RetentionValues, type TrashSettings } from "./api";
import { newIdempotencyKey, retentionConfirmation, retentionError, retentionNeedsConfirmation, trashErrorMessage } from "./model";

const SAVED = "Clean-up settings saved.";

/** Forced colours: keep the switch track and thumb visible and its position/state readable (system colours). */
const FORCED_SWITCH = [
  "forced-colors:[&_[role=switch]]:[forced-color-adjust:none]",
  "forced-colors:[&_[role=switch]]:border-[CanvasText]",
  "forced-colors:[&_[role=switch]]:bg-[Canvas]",
  "forced-colors:[&_[role=switch][data-state=checked]]:border-[Highlight]",
  "forced-colors:[&_[role=switch][data-state=checked]]:bg-[Highlight]",
  "forced-colors:[&_[role=switch]>span]:bg-[CanvasText]",
  "forced-colors:[&_[role=switch][data-state=checked]>span]:bg-[HighlightText]",
].join(" ");

export function lastRunText(settings: Pick<TrashSettings, "lastRun">): string | null {
  const run = settings.lastRun;
  if (!run) return null;
  if (run.status === "running") return "A clean-up is running now.";
  const deleted = `${run.purged} ${run.purged === 1 ? "item" : "items"} deleted permanently`;
  return run.status === "failed" || run.failed > 0
    ? `${deleted}, ${run.failed} failed (they are retried at the next run).`
    : `${deleted}.`;
}

export function RetentionPanel({ onAnnounce }: { onAnnounce: (text: string) => void }) {
  const api = useTrashApi();
  const settings = useQuery(api.settings.get.queryOptions());
  if (settings.isPending) return <Card title="Automatic clean-up"><div role="status" aria-label="Loading clean-up settings" className="p-4"><Skeleton lines={3} /></div></Card>;
  if (!settings.data) {
    return (
      <Card title="Automatic clean-up">
        <div className="p-4 sm:p-6"><Callout tone="danger">We couldn&apos;t load the clean-up settings.</Callout></div>
      </Card>
    );
  }
  return <RetentionForm settings={settings.data} onAnnounce={onAnnounce} />;
}

function RetentionForm({ settings, onAnnounce }: { settings: TrashSettings; onAnnounce: (text: string) => void }) {
  const api = useTrashApi();
  const client = useQueryClient();
  const stepUp = useStepUp();
  const update = useMutation(api.settings.update.mutationOptions());
  const [enabled, setEnabled] = useState(settings.autoPurgeEnabled);
  const [orderDays, setOrderDays] = useState(String(settings.orderDays));
  const [customerDays, setCustomerDays] = useState(String(settings.customerDays));
  // A new settings version (after a save, or changed elsewhere) resets the fields in place: the form is not
  // remounted, so focus and the heading stay where they are.
  const [seenVersion, setSeenVersion] = useState(settings.version);
  if (seenVersion !== settings.version) {
    setSeenVersion(settings.version);
    setEnabled(settings.autoPurgeEnabled);
    setOrderDays(String(settings.orderDays));
    setCustomerDays(String(settings.customerDays));
  }
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [review, setReview] = useState<{ values: RetentionValues; becomeDue: number; version: number; phrase: string | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const orderRef = useRef<HTMLInputElement>(null);
  const customerRef = useRef<HTMLInputElement>(null);
  const focusHeadingOnClose = useRef(false);
  /** Set to the heading after a successful save so the closing dialog focuses it (the opener may be disabled). */
  const returnFocus = useRef<HTMLElement | null>(null);
  const orderError = submitted ? retentionError(orderDays) : null;
  const customerError = submitted ? retentionError(customerDays) : null;
  const values: RetentionValues = { autoPurgeEnabled: enabled, orderDays: Number(orderDays), customerDays: Number(customerDays) };
  const changed = enabled !== settings.autoPurgeEnabled || orderDays.trim() !== String(settings.orderDays) || customerDays.trim() !== String(settings.customerDays);
  const lastRun = lastRunText(settings);

  /** Saves with step-up. Throws a customer message on failure (or a cancelled identity check). */
  const save = async (extra: { expectedVersion: number; reviewedDueCount?: number; confirmation?: string }, v: RetentionValues, announceNow = true) => {
    try {
      await stepUp.run(() => update.mutateAsync({ ...v, ...extra, idempotencyKey: newIdempotencyKey() }), { reason: "Changing trash clean-up requires a fresh identity check." });
    } catch (e) {
      const safe = safeError(e);
      if (safe?.reasonCode === "STALE" || safe?.reasonCode === "SETTINGS_CHANGED" || safe?.reasonCode === "STALE_VERSION") await client.invalidateQueries(api.settings.get.pathFilter());
      throw new Error(safe ? trashErrorMessage(safe.reasonCode, safe.safeMessage) : "Identity check cancelled. The settings were not changed.", { cause: e });
    }
    await Promise.all([client.invalidateQueries(api.settings.get.pathFilter()), client.invalidateQueries(api.list.pathFilter())]);
    if (announceNow) onAnnounce(SAVED);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    if (enabled && retentionError(orderDays)) { orderRef.current?.focus(); return; }
    if (enabled && retentionError(customerDays)) { customerRef.current?.focus(); return; }
    if (!retentionNeedsConfirmation(settings, values)) {
      try {
        await save({ expectedVersion: settings.version }, values);
        headingRef.current?.focus();
      } catch (e) {
        setError((e as Error).message);
      }
      return;
    }
    setChecking(true);
    try {
      const preview = await client.fetchQuery(api.settings.preview.queryOptions(values, { staleTime: 0 }));
      if (!preview.requiresConfirmation) {
        setChecking(false);
        try {
          await save({ expectedVersion: preview.version }, values);
          headingRef.current?.focus();
        } catch (e) {
          setError((e as Error).message);
        }
        return;
      }
      setDialogError(null);
      returnFocus.current = null;
      setReview({ values, becomeDue: preview.becomeDue, version: preview.version, phrase: preview.confirmationPhrase });
    } catch (e) {
      const safe = safeError(e);
      setError(trashErrorMessage(safe?.reasonCode, safe?.safeMessage));
    } finally {
      setChecking(false);
    }
  };

  return (
    <Card>
      <form onSubmit={submit} noValidate aria-labelledby="trash-retention-h" className="flex flex-col gap-4 p-4 sm:p-6">
        <div>
          <h2 id="trash-retention-h" ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-ink outline-none">Automatic clean-up</h2>
          <p className="mt-1 text-sm text-body">Items in the trash are deleted permanently when their retention period ends. The date is shown on every item and follows the current setting.</p>
        </div>
        <Switch className={FORCED_SWITCH} label="Delete items automatically when their retention period ends" checked={enabled} onCheckedChange={setEnabled} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Orders: days in the trash" hint="1 to 3650 days." error={orderError ?? undefined} required>
            <Input ref={orderRef} inputMode="numeric" value={orderDays} onChange={(e) => setOrderDays(e.target.value)} disabled={!enabled} />
          </Field>
          <Field label="Customer accounts: days in the trash" hint="1 to 3650 days. Orders moved with an account follow the account." error={customerError ?? undefined} required>
            <Input ref={customerRef} inputMode="numeric" value={customerDays} onChange={(e) => setCustomerDays(e.target.value)} disabled={!enabled} />
          </Field>
        </div>
        <div role="alert">{error ? <Callout tone="danger">{error}</Callout> : null}</div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!changed} loading={checking || update.isPending}>Save clean-up settings</Button>
          {!changed ? <span className="text-sm text-muted">No changes to save.</span> : null}
        </div>
        <div className="border-t border-line pt-4 text-sm text-body">
          <h3 className="font-semibold text-ink">Last clean-up</h3>
          {settings.lastRun ? (
            <p className="mt-1 break-words">
              {settings.lastRun.finishedAt ? <><DateTime value={settings.lastRun.finishedAt} />: </> : null}{lastRun}
            </p>
          ) : <p className="mt-1">No clean-up has run yet.</p>}
          <p className="mt-1">
            {settings.autoPurgeEnabled
              ? `${settings.nextDueCount} ${settings.nextDueCount === 1 ? "item is" : "items are"} due at the next clean-up.`
              : "Automatic clean-up is off: items stay in the trash until an administrator deletes them."}
          </p>
        </div>
      </form>
      <ConfirmDialog
        open={review !== null}
        onOpenChange={(open) => {
          if (open) return;
          setReview(null);
          setDialogError(null);
          // Saved: the Save button may now be disabled, so focus the panel heading instead of the opener.
          // Announce only after close: while the modal is open the page live region is hidden from assistive tech.
          // The timeout runs after the dialog's own close focus handling.
          if (focusHeadingOnClose.current) {
            focusHeadingOnClose.current = false;
            setTimeout(() => onAnnounce(SAVED), 0);
          }
        }}
        title={review && !settings.autoPurgeEnabled ? "Turn on automatic clean-up?" : "Shorten the retention period?"}
        description={review ? `${review.becomeDue} ${review.becomeDue === 1 ? "item becomes" : "items become"} due and will be deleted permanently at the next clean-up. This cannot be undone.` : undefined}
        confirmLabel="Save and confirm"
        returnFocusRef={returnFocus}
        destructive
        confirmText={review ? retentionConfirmation(review.becomeDue, review.phrase) : undefined}
        onConfirm={async () => {
          if (!review) return;
          setDialogError(null);
          try {
            await save({ expectedVersion: review.version, reviewedDueCount: review.becomeDue, confirmation: retentionConfirmation(review.becomeDue, review.phrase) }, review.values, false);
            focusHeadingOnClose.current = true;
            returnFocus.current = headingRef.current;
          } catch (e) {
            // Keep the confirmation open with the reason (cancelled identity check, changed meanwhile …).
            setDialogError((e as Error).message);
            throw e;
          }
        }}
      >
        <p>Copies remain in backups until those backups expire.</p>
        <div role="alert">{dialogError ? <Callout tone="danger" className="mt-3">{dialogError}</Callout> : null}</div>
      </ConfirmDialog>
    </Card>
  );
}
