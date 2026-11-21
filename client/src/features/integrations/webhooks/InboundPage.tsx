import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { WebhookInboundEndpointView } from "@server/modules/integrations/webhooks/types";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import { Badge, Button, Callout, DataTable, DateTime, EmptyState, Field, Input, LoadMore, Textarea } from "@/ui";
import { SecretOnceDialog, WebhookConfirmation, WebhookEditor, WebhooksHeader, useWebhookAction, type Confirmation } from "./common";

function EndpointEditor({ current, close, save }: {
  current: WebhookInboundEndpointView | null; close: () => void;
  save: (input: { name: string; endpointKey: string; description: string | null; toleranceSeconds: number }) => Promise<void>;
}) {
  const [name, setName] = useState(current?.name ?? "");
  const [endpointKey, setEndpointKey] = useState(current?.endpointKey ?? "");
  const [description, setDescription] = useState(current?.description ?? "");
  const [toleranceSeconds, setTolerance] = useState(current?.toleranceSeconds ?? 300);
  return <WebhookEditor title={current ? "Edit inbound endpoint" : "Create inbound endpoint"}
    description={current ? "The endpoint key and receive path do not change." : "New endpoints are disabled. Save the signing secret and configure your sender before enabling the endpoint."}
    close={close} submitLabel={current ? "Save endpoint" : "Create endpoint"}
    submit={() => save({ name: name.trim(), endpointKey: endpointKey.trim(), description: description.trim() || null, toleranceSeconds })}>
    <Field label="Name" required><Input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></Field>
    <Field label="Endpoint key" required={!current}
      hint={current ? "This identifier was set when the endpoint was created." : "Use a short, unique identifier with lower-case letters and numbers. Do not include a secret."}>
      <Input required={!current} readOnly={!!current} maxLength={64} autoComplete="off" value={endpointKey}
        onChange={(event) => setEndpointKey(event.target.value)} />
    </Field>
    <Field label="Description"><Textarea rows={2} maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
    <Field label="Timestamp tolerance (seconds)" required hint="Requests outside this window are refused. The maximum is 300 seconds.">
      <Input type="number" min={1} max={300} step={1} required value={toleranceSeconds || ""} onChange={(event) => setTolerance(Number(event.target.value))} />
    </Field>
  </WebhookEditor>;
}

export default function InboundPage() {
  const trpc = useTRPC().integrations.admin.webhooks;
  const rpc = useTRPCClient().integrations.admin.webhooks;
  const qc = useQueryClient();
  const act = useWebhookAction();
  const [editor, setEditor] = useState<{ current: WebhookInboundEndpointView | null } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const settings = useQuery(trpc.settings.get.queryOptions());
  const list = useInfiniteQuery(trpc.inbound.list.infiniteQueryOptions({ limit: 25 },
    { getNextPageParam: (page) => page.nextCursor ?? undefined }));
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const refresh = () => { void qc.invalidateQueries(trpc.inbound.pathFilter()); };

  function confirmFor(row: WebhookInboundEndpointView, mode: "toggle" | "rotate" | "remove") {
    const input = { publicId: row.publicId, expectedVersion: row.version };
    const action = {
      toggle: {
        title: row.enabled ? "Disable inbound endpoint?" : "Enable inbound endpoint?",
        description: row.enabled ? "New events will be refused." : "This endpoint can process correctly signed events when the webhook service is on.",
        label: row.enabled ? "Disable endpoint" : "Enable endpoint", destructive: row.enabled,
        run: async () => {
          if (await act(() => rpc.inbound.setEnabled.mutate({ ...input, enabled: !row.enabled }), {
            reason: "Changing an inbound endpoint requires fresh verification.", success: row.enabled ? "Endpoint disabled" : "Endpoint enabled",
          })) refresh();
        },
      },
      rotate: {
        title: "Rotate signing secret?", description: "The previous secret stays valid for 60 minutes. Save the new secret securely and update your sender before the overlap ends.",
        label: "Rotate secret", destructive: true,
        run: async () => {
          const result = await act(() => rpc.inbound.rotateSecret.mutate({ ...input, overlapMinutes: 60 }), { reason: "Rotating a signing secret requires fresh verification." });
          if (result) { setSecret(result.signingSecretOnce); refresh(); }
        },
      },
      remove: {
        title: "Remove inbound endpoint?", description: "Events sent to this receive path will no longer be processed. Existing records remain subject to retention.",
        label: "Remove endpoint", destructive: true,
        run: async () => {
          if (await act(() => rpc.inbound.remove.mutate(input), { reason: "Removing an inbound endpoint requires fresh verification.", success: "Endpoint removed" })) refresh();
        },
      },
    }[mode];
    setConfirmation(action);
  }

  return <>
    <WebhooksHeader page="inbound" title="Inbound webhook endpoints"
      description="Create receive paths for signed external events that can start automations."
      actions={<Button onClick={() => setEditor({ current: null })}>Create endpoint</Button>} />
    <div className="grid min-w-0 gap-4">
      {settings.data && !settings.data.enabled ? <Callout tone="info">The webhook service is off. Configure endpoints here and turn the service on from Subscriptions.</Callout> : null}
      <DataTable caption="Inbound endpoints" rows={rows} rowKey={(row) => row.publicId} loading={list.isPending}
        error={list.error} onRetry={() => void list.refetch()}
        empty={<EmptyState title="No inbound endpoints" description="Create an endpoint to configure a receive path and signing secret." />}
        columns={[
          { key: "name", header: "Endpoint", primary: true, cell: (row) => <span className="break-words">{row.name}</span> },
          { key: "status", header: "Status", cell: (row) => <Badge tone={row.enabled ? "success" : "neutral"}>{row.enabled ? "Enabled" : "Disabled"}</Badge> },
          { key: "path", header: "Receive path", cell: (row) => <code className="break-all">{row.receivePath}</code> },
          { key: "secret", header: "Secret ending", cell: (row) => <span>{row.signingSecretLast4}{row.hasOverlapSecret ? <> · Overlap until <DateTime value={row.overlapExpiresAt} /></> : null}</span> },
          { key: "recent", header: "Last received", cell: (row) => <DateTime value={row.lastReceivedAt} /> },
        ]} rowActions={(row) => <div className="flex flex-wrap gap-2">
          <Button variant="secondary" aria-label={`Edit ${row.name}`} onClick={() => setEditor({ current: row })}>Edit</Button>
          <Button variant="secondary" aria-label={`${row.enabled ? "Disable" : "Enable"} ${row.name}`}
            onClick={() => confirmFor(row, "toggle")}>{row.enabled ? "Disable" : "Enable"}</Button>
          <Button variant="secondary" aria-label={`Rotate secret for ${row.name}`} onClick={() => confirmFor(row, "rotate")}>Rotate secret</Button>
          <Button variant="ghost" aria-label={`Remove ${row.name}`} onClick={() => confirmFor(row, "remove")}>Remove</Button>
        </div>} />
      <LoadMore hasMore={list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} />
    </div>
    {editor ? <EndpointEditor current={editor.current} close={() => setEditor(null)} save={async ({ endpointKey, ...values }) => {
      const row = editor.current;
      if (row) {
        const updated = await act(() => rpc.inbound.update.mutate({ publicId: row.publicId, expectedVersion: row.version, ...values }),
          { reason: "Editing an inbound endpoint requires fresh verification.", success: "Endpoint updated" });
        if (!updated) return;
      } else {
        const created = await act(() => rpc.inbound.create.mutate({ endpointKey, ...values, enabled: false }),
          { reason: "Creating an inbound endpoint requires fresh verification." });
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
