/**
 * Running summary for the packet picker: selected packets, server-quoted subtotal/discount/total and the
 * bundle hint. The figures region is a polite live region so screen-reader users hear totals change.
 */
import { Card, Money, Skeleton } from "@/ui";
import { errorMessage } from "@/lib/trpc";
import { money } from "../../shared";
import { selectedPackets } from "./model";
import type { OrderQuote, PickerGroup } from "./types";

export interface PacketSummaryProps {
  groups: readonly PickerGroup[];
  selection: Record<number, string | null>;
  /** Latest server quote for the current selection (null when nothing is selected). */
  quote: OrderQuote | null | undefined;
  /** True while a quote for the current selection is being fetched. */
  pending?: boolean;
  error?: unknown;
  headingLevel?: 3 | 4;
}

export function bundleHint(quote: OrderQuote | null | undefined): string | null {
  const bundle = quote?.bundle;
  if (!bundle || bundle.applied) return null;
  const all = bundle.requiredPacketNumbers.length;
  const missing = bundle.missingPacketNumbers.length;
  const lead = all === 6 ? "Add all six packets" : `Add all ${all} packets`;
  return `${lead} for ${bundle.discountPercent}% off${missing > 0 && missing < all ? ` (${missing} more to go)` : ""}.`;
}

export function PacketSummary({ groups, selection, quote, pending, error, headingLevel = 3 }: PacketSummaryProps) {
  const chosen = selectedPackets(selection, groups);
  const hint = bundleHint(quote);
  return (
    <Card title="Your packets" headingLevel={headingLevel} className="lg:sticky lg:top-20">
      {chosen.length === 0 ? (
        <p className="text-sm text-body">No packets chosen yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line text-sm">
          {chosen.map((line) => (
            <li key={line.packetNumber} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2">
              <span className="min-w-0 break-words text-ink">
                Packet {line.packetNumber}: {line.packetName} — {line.product.tier}
              </span>
              <Money value={money(line.product.priceMinor, line.product.currency)} />
            </li>
          ))}
        </ul>
      )}
      <div role="status" aria-live="polite" aria-atomic="true" className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-sm" data-testid="packet-summary-figures">
        {chosen.length === 0 ? null : error ? (
          <p className="text-danger">{errorMessage(error, "We couldn't price this selection. Try again.")}</p>
        ) : pending || !quote ? (
          <>
            <span className="sr-only">Updating total…</span>
            <Skeleton lines={2} />
          </>
        ) : (
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
            <dt className="text-body">Subtotal</dt>
            <dd className="text-right text-ink">
              <Money value={money(quote.subtotalMinor, quote.currency)} />
            </dd>
            {quote.discountMinor > 0 ? (
              <>
                <dt className="text-body">{quote.discountLabel ?? "Discount"}</dt>
                <dd className="text-right text-ink">
                  −<Money value={money(quote.discountMinor, quote.currency)} />
                </dd>
              </>
            ) : null}
            <dt className="font-semibold text-ink">Total</dt>
            <dd className="text-right font-semibold text-ink">
              <Money value={money(quote.totalMinor, quote.currency)} />
            </dd>
          </dl>
        )}
        {hint ? <p className="text-muted">{hint}</p> : null}
      </div>
    </Card>
  );
}
