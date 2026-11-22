import { useId, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { errorMessage } from "@/lib/trpc";
import { Button, Callout, CodeBlock, ConfirmDialog, Dialog, PageHeader, StepUpCancelledError, useStepUp, useToast } from "@/ui";
import { WEBHOOK_PATHS } from "./paths";

const sections = [
  ["subscriptions", "Subscriptions"], ["inbound", "Inbound endpoints"], ["deliveries", "Deliveries"],
] as const;

export function WebhooksHeader({ page, title, description, actions }: {
  page: keyof typeof WEBHOOK_PATHS; title: string; description: string; actions?: ReactNode;
}) {
  return <>
    <PageHeader title={title} description={description} actions={actions} />
    <nav aria-label="Webhooks sections" className="mb-4 flex flex-wrap gap-2">
      {sections.map(([key, label]) => <Button key={key} asChild variant={key === page ? "secondary" : "ghost"}>
        <Link href={WEBHOOK_PATHS[key]} aria-current={key === page ? "page" : undefined}>{label}</Link>
      </Button>)}
    </nav>
  </>;
}

// Callers use an imperative tRPC client for any result that includes a signing secret or payload.
export function useWebhookAction() {
  const stepUp = useStepUp();
  const toast = useToast();
  return async function act<Result>(action: () => Promise<Result>, options: { reason: string; success?: string }) {
    try {
      const result = await stepUp.run(action, { reason: options.reason });
      if (options.success) toast.show({ tone: "success", title: options.success });
      return result;
    } catch (failure) {
      if (failure instanceof StepUpCancelledError) return undefined;
      toast.show({ tone: "danger", title: "Webhook action not completed", description: errorMessage(failure) });
      throw failure;
    }
  };
}

export function SecretOnceDialog({ secret, close }: { secret: string; close: () => void }) {
  return <Dialog open title="Signing secret" description="Copy this secret to your secure configuration now. It will not be shown again."
    onOpenChange={(open) => { if (!open) close(); }}
    footer={<Button onClick={close}>Done</Button>}>
    <div className="ph-no-capture" data-clarity-mask="true">
      <Callout tone="warning">Do not put the secret in a URL, a support ticket, or an application log.</Callout>
      <CodeBlock label="Webhook signing secret" wrap copyable className="mt-3">{secret}</CodeBlock>
    </div>
  </Dialog>;
}

export type Confirmation = { title: string; description: string; label: string; destructive?: boolean; run: () => Promise<void> };

export function WebhookConfirmation({ action, close }: { action: Confirmation; close: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return <ConfirmDialog open onOpenChange={(open) => { if (!open) close(); }}
    title={action.title} description={action.description} confirmLabel={action.label} destructive={action.destructive}
    onConfirm={async () => {
      setError(null);
      try { await action.run(); }
      catch (failure) { setError(errorMessage(failure)); throw failure; }
    }}>
    {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
  </ConfirmDialog>;
}

export function WebhookEditor({ title, description, submit, close, children, submitLabel = "Save", submitDisabled = false }: {
  title: string; description: string; submit: () => Promise<void>; close: () => void; children: ReactNode; submitLabel?: string; submitDisabled?: boolean;
}) {
  const form = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <Dialog open title={title} description={description} dismissible={!busy}
    onOpenChange={(open) => { if (!open && !busy) close(); }}
    footer={<>
      <Button variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
      <Button form={form} type="submit" loading={busy} disabled={submitDisabled}>{submitLabel}</Button>
    </>}>
    <form id={form} className="grid min-w-0 gap-4" onSubmit={(event) => {
      event.preventDefault();
      if (busy || submitDisabled) return;
      setError(null);
      setBusy(true);
      void submit().catch((failure) => setError(errorMessage(failure))).finally(() => setBusy(false));
    }}>
      <fieldset disabled={busy} className="grid min-w-0 gap-4">{children}</fieldset>
      {error ? <Callout tone="danger" live="assertive">{error}</Callout> : null}
    </form>
  </Dialog>;
}
