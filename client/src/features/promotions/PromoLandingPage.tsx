/**
 * Promotion link landing (`/promo#promo=CODE`, public). Owner: audit engineer.
 * Saves the code from the fragment for this browser tab (sessionStorage), strips the fragment at once, and says
 * so. Nothing is applied here: PromoCodeField in the cart and the order wizard offers the saved code.
 */
import { useState } from "react";
import { Link } from "wouter";
import { CheckCircle2 } from "lucide-react";
import { Button, Callout, Card, PageHeader } from "@/ui";
import { useSession } from "@/lib/session";
import { capturePromoCodeFromFragment, clearSavedPromoCode, readSavedPromoCode, type FragmentCapture } from "./savedCode";

type LandingState = { kind: "saved" } | { kind: "invalid" } | { kind: "none" };

function initialState(): LandingState {
  const capture: FragmentCapture = typeof window === "undefined" ? { kind: "none" } : capturePromoCodeFromFragment();
  if (capture.kind === "invalid") return { kind: "invalid" };
  // A repeated render (or a reload after the fragment was stripped) still finds the code saved for this tab.
  return readSavedPromoCode() ? { kind: "saved" } : { kind: "none" };
}

export default function PromoLandingPage() {
  const { view } = useSession();
  const [state, setState] = useState<LandingState>(initialState);
  const signedIn = view.status === "full";

  return (
    <article className="ph-no-capture mx-auto w-full min-w-0 max-w-2xl space-y-6 px-4 py-8 sm:px-6 sm:py-12" data-clarity-mask="true">
      <PageHeader title="Discount code" description="Codes from a ReadyPackets link are kept for this browser tab only." />
      {state.kind === "saved" ? (
        <Callout tone="success" title="Code saved" live="polite">
          <span className="inline-flex items-start gap-1">
            <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>It is applied when you place an order: choose it in your cart or when you start a new order. Every rule of the code still applies.</span>
          </span>
        </Callout>
      ) : state.kind === "invalid" ? (
        <Callout tone="warning" title="This link does not contain a usable code" live="polite">
          Check the link you received, or enter the code yourself in your cart.
        </Callout>
      ) : (
        <Callout tone="info" title="No code saved">
          Open the link you received again, or enter the code yourself in your cart.
        </Callout>
      )}
      <Card as="section" aria-labelledby="promo-next" className="space-y-3">
        <h2 id="promo-next" className="text-lg font-semibold text-ink">Next steps</h2>
        {signedIn ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button asChild><Link href="/cart">Go to your cart</Link></Button>
            <Button asChild variant="secondary"><Link href="/orders/new">Start a new order</Link></Button>
          </div>
        ) : (
          <>
            <p className="text-body">Sign in or create an account. The saved code stays available in this tab.</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button asChild><Link href="/sign-in">Sign in</Link></Button>
              <Button asChild variant="secondary"><Link href="/register">Create an account</Link></Button>
            </div>
          </>
        )}
        {state.kind === "saved" ? (
          <Button
            variant="link"
            onClick={() => {
              clearSavedPromoCode();
              setState({ kind: "none" });
            }}
          >
            Forget the saved code
          </Button>
        ) : null}
      </Card>
    </article>
  );
}
