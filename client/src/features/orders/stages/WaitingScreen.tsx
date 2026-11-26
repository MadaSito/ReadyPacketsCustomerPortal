/**
 * Increment 08 (D6) — one clear screen when the customer has nothing to do in the current phase (audit_engineer):
 * what happens next and, where there is one, the single useful action (Pay now, download deliverables, the page's
 * status actions). Never a dead end without an explanation.
 */
import { forwardRef, type ReactNode } from "react";
import { Callout, type CalloutTone } from "@/ui";
import { WAITING_MESSAGE, type WaitingKind } from "./wizardModel";

const TITLE: Record<WaitingKind, string> = {
  payment: "Waiting for your payment",
  team: "We are working on this phase",
  status_action: "Your decision is needed",
  submitted: "Thank you, we have what we need",
  delivered: "Your order is complete",
  nothing: "Nothing is needed from you right now",
  canceled: "This order was canceled",
};

const TONE: Record<WaitingKind, CalloutTone> = {
  payment: "info", team: "info", status_action: "warning", submitted: "success", delivered: "success", nothing: "info", canceled: "info",
};

export function waitingText(kind: WaitingKind, nextLabel: string | null): string {
  switch (kind) {
    case "payment": return WAITING_MESSAGE.payment;
    case "team": return nextLabel ? `${WAITING_MESSAGE.team} Next: ${nextLabel}.` : WAITING_MESSAGE.team;
    case "status_action": return WAITING_MESSAGE.status_action;
    case "submitted": return nextLabel ? `Our team reviews what you sent and lets you know. Next: ${nextLabel}.` : "Our team reviews what you sent and lets you know.";
    case "delivered": return "Everything for this order has been delivered. Your files are in the order details.";
    case "nothing": return "We'll let you know by e-mail and on this page when there is something to do.";
    case "canceled": return "Nothing more can be done on this order. You can still read its details.";
  }
}

export const WaitingScreen = forwardRef<HTMLDivElement, { kind: WaitingKind; nextLabel?: string | null; action?: ReactNode; headingLevel?: 3 | 4 }>(
  function WaitingScreen({ kind, nextLabel = null, action, headingLevel = 3 }, ref) {
    const Heading = headingLevel === 3 ? "h3" : "h4";
    return (
      <div ref={ref} tabIndex={-1} className="outline-none" data-wizard-waiting={kind}>
        <Callout tone={TONE[kind]}>
          <Heading className="text-base font-semibold text-ink">{TITLE[kind]}</Heading>
          <p className="mt-1 break-words">{waitingText(kind, nextLabel)}</p>
          {action ? <div className="mt-3">{action}</div> : null}
        </Callout>
      </div>
    );
  },
);
