import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { WebhookCatalogueEventView, WebhookSubscriptionView, WebhooksSettingsView } from "@server/modules/integrations/webhooks/types";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import { Badge, Button, Callout, Card, Checkbox, DataTable, DateTime, EmptyState, ErrorState, Field, Input, LoadMore, Skeleton, Textarea } from "@/ui";
import { SecretOnceDialog, WebhookConfirmation, WebhookEditor, WebhooksHeader, useWebhookAction, type Confirmation } from "./common";

const stateLabel = { active: "Active", paused: "Paused", disabled_failing: "Disabled after failures" };

function SettingsEditor({ current, close, save }: {
  current: WebhooksSettingsView; close: () => void; save: (settings: WebhooksSettingsView) => Promise<void>;
}) {
  const [values, setValues] = useState(current);
  return <WebhookEditor title="Webhook settings" description="This switch controls both inbound processing and outbound delivery."
    close={close} submit={() => save(values)}>
    <Checkbox label="Enable webhooks" checked={values.enabled} onCheckedChange={(enabled) => setValues({ ...values, enabled })} />
    <Field label="Log retention (days)" hint="Determines how long registered delivery records and payloads are retained.">
      <Input type="number" min={1} step={1} required value={values.retentionDays || ""}
        onChange={(event) => setValues({ ...values, retentionDays: Number(event.target.value) })} />
    </Field>
    <Field label="Failures before automatic disable">
      <Input type="number" min={1} step={1} required value={values.autoDisableThreshold || ""}
        onChange={(event) => setValues({ ...values, autoDisableThreshold: Number(event.target.value) })} />
    </Field>
    <Field label="Delivery timeout (milliseconds)">
      <Input type="number" min={1} step={1} required value={values.deliveryTimeoutMs || ""}
        onChange={(event) => setValues({ ...values, deliveryTimeoutMs: Number(event.target.value) })} />
    </Field>
  </WebhookEditor>;
}

function SubscriptionEditor({ current, catalogue, close, save }: {
  current: WebhookSubscriptionView | null; catalogue: WebhookCatalogueEventView[]; close: () => void;
  save: (input: { name: string; description: string | null; targetUrl: string; events: string[] }) => Promise<void>;
}) {
  const [name, setName] = useState(current?.name ?? "");
  const [description, setDescription] = useState(current?.description ?? "");
  const [targetUrl, setTargetUrl] = useState("");
  const [events, setEvents] = useState(current?.events ?? []);
  const [eventError, setEventError] = useState(false);
  const [urlError, setUrlError] = useState(false);
  return <WebhookEditor title={current ? "Edit subscription" : "Create subscription"}
    description={current ? "Review event selections and the outbound destination." : "New subscriptions start paused. Verify the destination, save its signing secret, then resume when ready."}
    close={close} submitLabel={current ? "Save subscription" : "Create subscription"} submit={async () => {
      setEventError(!events.length);
      if (targetUrl.trim()) {
        const url = URL.canParse(targetUrl.trim()) ? new URL(targetUrl.trim()) : null;
        const invalid = !url || url.protocol !== "https:" || !!url.username || !!url.password || !!url.hash;
        setUrlError(invalid);
        if (invalid) return;
      }
      if (events.length) await save({ name: name.trim(), description: description.trim() || null, targetUrl: targetUrl.trim(), events });
    }}>
    <Field label="Name" required><Input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></Field>
    <Field label="Description"><Textarea rows={2} maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
    <Field label="Destination URL" required={!current} error={urlError ? "Enter an HTTPS URL without credentials or a fragment." : undefined}
      hint={current ? `Current destination: ${current.targetUrlMasked}. Leave blank to keep it.` : "Use an HTTPS destination allowed by the outbound connection policy."}>
      <Input type="url" required={!current} maxLength={2048} autoComplete="off" value={targetUrl}
        className="ph-no-capture" data-clarity-mask="true" onChange={(event) => { setTargetUrl(event.target.value); setUrlError(false); }} />
    </Field>
    <fieldset className="grid min-w-0 gap-2">
      <legend className="text-sm font-semibold">Events to deliver</legend>
      {eventError ? <Callout tone="danger" live="assertive">Select at least one event.</Callout> : null}
      {catalogue.map(({ key, label, description: eventDescription }) => <Checkbox key={key} label={label}
        description={eventDescription} checked={events.includes(key)} onCheckedChange={(selected) => {
          setEventError(false);
          setEvents((currentEvents) => selected ? [...currentEvents, key] : currentEvents.filter((item) => item !== key));
        }} />)}
    </fieldset>
  </WebhookEditor>;
}

export default function SubscriptionsPage() {
  const trpc = useTRPC().integrations.admin.webhooks;
  const rpc = useTRPCClient().integrations.admin.webhooks;
  const qc = useQueryClient();
  const act = useWebhookAction();
  const [settingsEditor, setSettingsEditor] = useState<WebhooksSettingsView | null>(null);
  const [editor, setEditor] = useState<{ current: WebhookSubscriptionView | null } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const settings = useQuery(trpc.settings.get.queryOptions());
  const catalogue = useQuery(trpc.catalogue.queryOptions());
  const list = useInfiniteQuery(trpc.subscriptions.list.infiniteQueryOptions({ limit: 25 },
    { getNextPageParam: (page) => page.nextCursor ?? undefined }));
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const refresh = () => { void qc.invalidateQueries(trpc.subscriptions.pathFilter()); };

  function confirmFor(row: WebhookSubscriptionView, mode: "pause" | "rotate" | "test" | "remove") {
    const input = { publicId: row.publicId, expectedVersion: row.version };
    const pause = row.status === "active";
    const action = {
      pause: { title: pause ? "Pause subscription?" : "Resume subscription?",
        description: pause ? "New events will not be delivered by this subscription." : "New matching events may be sent to the configured destination.",
        label: pause ? "Pause" : "Resume", destructive: pause, run: async () => {
          if (await act(() => rpc.subscriptions.setPaused.mutate({ ...input, paused: pause }), { reason: "Changing a subscription requires fresh verification.", success: pause ? "Subscription paused" : "Subscription resumed" })) refresh();
        } },
      rotate: { title: "Rotate signing secret?", description: "The previous secret stays valid for 60 minutes. Save the new secret securely and update your receiver before the overlap ends.",
        label: "Rotate secret", destructive: true, run: async () => {
          const result = await act(() => rpc.subscriptions.rotateSecret.mutate({ ...input, overlapMinutes: 60 }), { reason: "Rotating a signing secret requires fresh verification." });
          if (result) { setSecret(result.signingSecretOnce); refresh(); }
        } },
      test: { title: "Send test delivery?", description: `A test event will be queued for ${row.targetUrlHost}. It does not contain a real customer event.`,
        label: "Queue test delivery", run: async () => {
          await act(() => rpc.subscriptions.testDelivery.mutate({ publicId: row.publicId }), {
            reason: "Testing a webhook requires fresh verification.", success: "Test delivery queued. Check Deliveries for the outcome.",
          });
          void qc.invalidateQueries(trpc.deliveries.pathFilter());
        } },
      remove: { title: "Remove subscription?", description: "The subscription will stop delivering events. Previously recorded delivery attempts remain visible according to retention.",
        label: "Remove subscription", destructive: true, run: async () => {
          if (await act(() => rpc.subscriptions.remove.mutate(input), { reason: "Removing a subscription requires fresh verification.", success: "Subscription removed" })) refresh();
        } },
    }[mode];
    setConfirmation(action);
  }

  return <>
    <WebhooksHeader page="subscriptions" title="Webhook subscriptions" description="Manage outbound subscriptions, destination policy, and signing secrets."
      actions={<Button onClick={() => setEditor({ current: null })} disabled={!catalogue.data?.length}>Create subscription</Button>} />
    <div className="grid min-w-0 gap-4">
      {settings.isPending ? <Skeleton lines={2} /> : null}
      {settings.isError ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} /> : null}
      {settings.data ? <Card title="Webhook service"
        actions={<><Badge tone={settings.data.enabled ? "success" : "neutral"}>{settings.data.enabled ? "On" : "Off"}</Badge>
          <Button variant="secondary" onClick={() => setSettingsEditor(settings.data)}>Settings</Button></>}>
        <p className="text-sm text-muted">{settings.data.enabled ? "Inbound and outbound webhooks are enabled."
          : "Webhooks are off. You can configure subscriptions or endpoints before turning the service on."}</p>
      </Card> : null}
      {catalogue.isError ? <ErrorState error={catalogue.error} onRetry={() => void catalogue.refetch()} /> : null}
      <DataTable caption="Outbound subscriptions" rows={rows} rowKey={(row) => row.publicId} loading={list.isPending}
        error={list.error} onRetry={() => void list.refetch()}
        empty={<EmptyState title="No webhook subscriptions" description="Create a paused subscription to start configuring outbound deliveries." />}
        columns={[
          { key: "name", header: "Subscription", primary: true, cell: (row) => <span className="break-words">{row.name}</span> },
          { key: "destination", header: "Destination", cell: (row) => <span className="break-all">{row.targetUrlMasked}</span> },
          { key: "state", header: "Status", cell: (row) => <Badge tone={row.status === "active" ? "success" : row.status === "disabled_failing" ? "danger" : "neutral"}>{stateLabel[row.status]}</Badge> },
          { key: "events", header: "Events", cell: (row) => row.events.length },
          { key: "secret", header: "Secret ending", cell: (row) => <span>{row.signingSecretLast4}{row.hasOverlapSecret ? <> · Overlap until <DateTime value={row.overlapExpiresAt} /></> : null}</span> },
          { key: "delivered", header: "Last delivered", cell: (row) => <DateTime value={row.lastDeliveredAt} /> },
          { key: "failures", header: "Consecutive failures", cell: (row) => row.consecutiveFailures },
        ]} rowActions={(row) => <div className="flex flex-wrap gap-2">
          <Button variant="secondary" aria-label={`Edit ${row.name}`} disabled={!catalogue.data?.length} onClick={() => setEditor({ current: row })}>Edit</Button>
          <Button variant="secondary" aria-label={`${row.status === "active" ? "Pause" : "Resume"} ${row.name}`} onClick={() => confirmFor(row, "pause")}>{row.status === "active" ? "Pause" : "Resume"}</Button>
          <Button variant="secondary" aria-label={`Rotate secret for ${row.name}`} onClick={() => confirmFor(row, "rotate")}>Rotate secret</Button>
          <Button variant="secondary" aria-label={`Queue test for ${row.name}`} disabled={!settings.data?.enabled} onClick={() => confirmFor(row, "test")}>Test delivery</Button>
          <Button variant="ghost" aria-label={`Remove ${row.name}`} onClick={() => confirmFor(row, "remove")}>Remove</Button>
        </div>} />
      <LoadMore hasMore={list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} />
    </div>
    {settingsEditor ? <SettingsEditor current={settingsEditor} close={() => setSettingsEditor(null)} save={async (values) => {
      const result = await act(() => rpc.settings.update.mutate(values), { reason: "Changing webhook settings requires fresh verification.", success: "Webhook settings saved" });
      if (result) { qc.setQueryData(trpc.settings.get.queryKey(), result); setSettingsEditor(null); }
    }} /> : null}
    {editor && catalogue.data ? <SubscriptionEditor current={editor.current} catalogue={catalogue.data} close={() => setEditor(null)} save={async (values) => {
      const row = editor.current;
      if (row) {
        const updated = await act(() => rpc.subscriptions.update.mutate({
          publicId: row.publicId, expectedVersion: row.version, ...values, targetUrl: values.targetUrl || undefined,
        }), { reason: "Editing a subscription requires fresh verification.", success: "Subscription updated" });
        if (!updated) return;
      } else {
        const created = await act(() => rpc.subscriptions.create.mutate({ ...values, paused: true }), { reason: "Creating a subscription requires fresh verification." });
        if (!created) return;
        setSecret(created.signingSecretOnce);
      }
      setEditor(null);
      refresh();
    }} /> : null}
    {confirmation ? <WebhookConfirmation action={confirmation} close={() => setConfirmation(null)} /> : null}
    {secret && !confirmation && !editor ? <SecretOnceDialog secret={secret} close={() => setSecret(null)} /> : null}
  </>;
}
