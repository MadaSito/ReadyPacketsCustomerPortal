/**
 * Customer order acceptance gate (package V, ADR 0039). Owner: identity_engineer.
 * Full-width panel on the customer order page while a policy gate for this order is unmet. The user can still
 * read the order; uploads, recordings, intake and phase submits are refused by the SERVER until accepted —
 * this panel is a convenience, never the control. Each person with access accepts for themselves.
 */
import type { inferRouterOutputs } from "@trpc/server";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileSignature, ShieldCheck } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "wouter";
import type { AppRouter } from "@server/trpc/root";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { Badge, Button, Callout, Card, Checkbox, DateTime, Field, Input, useToast } from "@/ui";
import { SafePolicyText } from "../shared";

type ForOrder = inferRouterOutputs<AppRouter>["compliance"]["acceptance"]["forOrder"];
export type GateView = ForOrder["gates"][number];

export interface AcceptanceGateProps {
  orderId: string;
  area: "customer" | "console";
}

export function receiptHref(area: "customer" | "console", receiptId: string): string {
  return area === "console" ? `/admin/acceptance-receipts/${encodeURIComponent(receiptId)}` : `/acceptance-receipts/${encodeURIComponent(receiptId)}`;
}

/** Set only by the user's own submit (never by background refetches), so focus is moved only in response to them. */
interface LocalOutcome {
  kind: "accepted" | "error";
  gateKey: string;
  message?: string;
}

function GateForm({ orderId, gate, carried, focusText, onOutcome }: {
  orderId: string;
  gate: GateView;
  /** An error from this gate's previous form instance (it remounts when the policy version changes). */
  carried: string | null;
  focusText: boolean;
  onOutcome: (outcome: LocalOutcome) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [agreed, setAgreed] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [error, setError] = useState<string | null>(carried);
  const textId = useId();
  const textRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusText) textRef.current?.focus();
  }, [focusText]);
  const typed = gate.signatureMode === "typed_name";
  const policy = gate.policy!;

  const accept = useMutation(
    trpc.compliance.acceptance.accept.mutationOptions({
      onSuccess: async () => {
        toast.show({ tone: "success", title: "Thank you — your acceptance is recorded." });
        onOutcome({ kind: "accepted", gateKey: gate.key });
        await queryClient.invalidateQueries({ queryKey: trpc.compliance.acceptance.forOrder.queryKey({ orderId }) });
      },
      onError: async (e) => {
        const message = errorMessage(e);
        setError(message);
        onOutcome({ kind: "error", gateKey: gate.key, message });
        await queryClient.invalidateQueries({ queryKey: trpc.compliance.acceptance.forOrder.queryKey({ orderId }) });
      },
    }),
  );

  const canSubmit = agreed && (!typed || typedName.trim().length >= 2) && !accept.isPending;

  return (
    <form
      className="flex flex-col gap-4"
      aria-label={`Accept ${policy.title}`}
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        if (!canSubmit) return;
        accept.mutate({
          orderId,
          gateKey: gate.key,
          policyVersionId: policy.versionId,
          textSha256: policy.textSha256,
          ...(typed ? { typedName } : {}),
        });
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-ink">{policy.title}</h3>
        <Badge tone="neutral">Version {policy.versionLabel}</Badge>
      </div>
      <div
        id={textId}
        ref={textRef}
        role="region"
        aria-label={`${policy.title}, full text`}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Allow keyboard scrolling of the bounded policy text.
        tabIndex={0}
        className="max-h-96 overflow-y-auto rounded-[var(--radius-control)] border border-line bg-surface-sunken p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <SafePolicyText bodyText={policy.text} format={policy.contentFormat} />
      </div>
      {typed ? (
        <Field label="Type your full name to sign" hint="Your typed name is your signature on this order." required>
          <Input value={typedName} onChange={(e) => setTypedName(e.target.value)} autoComplete="name" maxLength={120} />
        </Field>
      ) : null}
      <Checkbox
        label={`I have read and agree to ${policy.title} (version ${policy.versionLabel}).`}
        checked={agreed}
        onCheckedChange={setAgreed}
        required
      />
      {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
      <div>
        <Button type="submit" disabled={!canSubmit} loading={accept.isPending} leadingIcon={<FileSignature className="h-4 w-4" aria-hidden />}>
          {typed ? "Sign and accept" : "Accept"}
        </Button>
      </div>
    </form>
  );
}

/** Order-page banner. Renders nothing for staff, while loading, or when the order has no gates. */
export default function AcceptanceGate({ orderId, area }: AcceptanceGateProps) {
  const trpc = useTRPC();
  const query = useQuery({ ...trpc.compliance.acceptance.forOrder.queryOptions({ orderId }), enabled: area === "customer" });
  const gates = area === "customer" ? (query.data?.gates ?? []) : [];
  const pending = gates.filter((g) => g.required && g.applies && !g.met);
  const accepted = gates.filter((g) => g.acceptance);
  // When the last pending gate is accepted the form unmounts; move focus to the confirmation so it isn't lost.
  const [outcome, setOutcome] = useState<LocalOutcome | null>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);
  const allDone = pending.length === 0 && accepted.length > 0;
  const handled = useRef<LocalOutcome | null>(null);
  useEffect(() => {
    if (outcome?.kind === "accepted" && allDone && handled.current !== outcome) {
      handled.current = outcome;
      doneRef.current?.focus();
    }
  }, [outcome, allDone]);
  // After a local signing, the next pending policy's text gets focus; after a local conflict, the same gate's
  // (possibly re-versioned) text does, with the message carried over. Background refetches never move focus.
  const focusKey = outcome
    ? outcome.kind === "accepted"
      ? pending.find((g) => g.key !== outcome.gateKey)?.key
      : outcome.gateKey
    : undefined;
  if (gates.length === 0) return null;

  if (pending.length === 0) {
    if (accepted.length === 0) return null;
    return (
      <p ref={doneRef} tabIndex={-1} className="flex flex-wrap items-center gap-2 text-sm text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
        <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
        <span>Policies accepted for this order:</span>
        {accepted.map((g) => (
          <Link key={g.key} href={receiptHref("customer", g.acceptance!.receiptId)} className="text-brand underline underline-offset-2">
            {g.policy?.title ?? "Policy"} receipt
          </Link>
        ))}
      </p>
    );
  }

  return (
    <Card
      as="section"
      aria-label="Policy acceptance required"
      title="Please review and accept before you continue"
      description="You can read this order, but uploads, recordings, questionnaire answers and phase submissions are paused until you accept. Everyone with access to the order accepts for themselves."
      actions={<ShieldCheck className="h-5 w-5 text-brand" aria-hidden />}
    >
      <div className="flex flex-col gap-8">
        {pending.map((gate) =>
          gate.policy ? (
            <GateForm
              key={`${gate.key}:${gate.policy.versionId}`}
              orderId={orderId}
              gate={gate}
              carried={outcome?.kind === "error" && outcome.gateKey === gate.key ? (outcome.message ?? null) : null}
              focusText={focusKey === gate.key}
              onOutcome={setOutcome}
            />
          ) : (
            <Callout key={gate.key} tone="warning" title="A required policy isn't available">
              This order needs a policy that isn't published right now. Please contact support.
            </Callout>
          ),
        )}
        {accepted.length > 0 ? (
          <p className="text-sm text-muted">
            Already accepted:{" "}
            {accepted.map((g, i) => (
              <span key={g.key}>
                {i > 0 ? ", " : null}
                {g.policy?.title ?? "Policy"} on <DateTime value={g.acceptance!.acceptedAt} format="date" />
              </span>
            ))}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
