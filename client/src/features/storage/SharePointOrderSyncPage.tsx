/**
 * SharePoint order-data list sync settings & status page (/admin/sharepoint-sync).
 *
 * Sibling path under /admin/sharepoint-sync (not /admin/storage/sharepoint) so
 * ConsoleShell active-prefix highlighting distinguishes it from /admin/storage.
 */
import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "@/lib/trpc";
import {
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  DateTime,
  EmptyState,
  ErrorState,
  Field,
  Input,
  KeyValueList,
  LoadMore,
  PageHeader,
  Select,
  Skeleton,
  StepUpCancelledError,
  Switch,
  useStepUp,
  useToast,
  type Column,
} from "@/ui";
import { useStorageApi, useStorageDirectClient } from "./api";
import {
  ORDER_SYNC_TEST_CODE_LABELS,
  type OrderSyncStatusRow,
  type OrderSyncTestCode,
  type SharePointListSummary,
  type SharePointSyncRowState,
} from "./model";

const INVALID_LIST_NAME_RE = /[#%*:<>?/\\|"]/;

export function SharePointOrderSyncPage() {
  const api = useStorageApi();
  const storageClient = useStorageDirectClient();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();

  const connectionsQuery = useQuery(api.connectionsList.queryOptions({ limit: 100 }));
  const settingsQuery = useQuery({
    ...api.orderSyncGet.queryOptions(),
    refetchInterval: (q) => (q.state.data?.backfill?.state === "running" ? 3_000 : false),
  });

  const [statusFilter, setStatusFilter] = useState<"all" | SharePointSyncRowState>("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const statusQuery = useQuery(
    api.orderSyncStatus.queryOptions({
      limit: 50,
      ...(cursor ? { cursor } : {}),
      ...(statusFilter === "all" ? {} : { state: statusFilter }),
    }),
  );

  const [connectionDraft, setConnectionDraft] = useState<string | null>(null);
  const [savingAssignment, setSavingAssignment] = useState(false);

  const [lists, setLists] = useState<SharePointListSummary[] | null>(null);
  const [loadingLists, setLoadingLists] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [newListError, setNewListError] = useState<string | undefined>(undefined);
  const [creatingList, setCreatingList] = useState(false);

  const [listIdDraft, setListIdDraft] = useState<string | null>(null);
  const [listLabelDraft, setListLabelDraft] = useState<string | null>(null);
  const [portalLinkDraft, setPortalLinkDraft] = useState<boolean | null>(null);
  const [enabledDraft, setEnabledDraft] = useState<boolean | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; code: OrderSyncTestCode } | null>(null);
  const [runningBackfill, setRunningBackfill] = useState(false);
  const [runningResync, setRunningResync] = useState(false);

  const refreshAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: api.orderSyncGet.queryKey() }),
      queryClient.invalidateQueries({ queryKey: api.orderSyncStatus.queryKey() }),
      queryClient.invalidateQueries({ queryKey: api.connectionsList.queryKey() }),
      queryClient.invalidateQueries({ queryKey: api.assignmentsList.queryKey() }),
    ]);
  };

  const anyError = connectionsQuery.error ?? settingsQuery.error ?? statusQuery.error;
  const anyPending =
    connectionsQuery.isPending || settingsQuery.isPending || statusQuery.isPending;

  if (anyError) {
    return (
      <>
        <PageHeader
          title="SharePoint order sync"
          description="Mirror structured ReadyPackets order summaries to a Microsoft 365 SharePoint list."
        />
        <ErrorState
          error={anyError}
          title="Could not load SharePoint order sync"
          onRetry={() => {
            void connectionsQuery.refetch();
            void settingsQuery.refetch();
            void statusQuery.refetch();
          }}
        />
      </>
    );
  }

  if (anyPending || !connectionsQuery.data || !settingsQuery.data || !statusQuery.data) {
    return (
      <>
        <PageHeader
          title="SharePoint order sync"
          description="Mirror structured ReadyPackets order summaries to a Microsoft 365 SharePoint list."
        />
        <div className="flex flex-col gap-4" role="status" aria-busy="true" aria-label="Loading SharePoint order sync">
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </>
    );
  }

  const settings = settingsQuery.data;
  const sharepointConnections = connectionsQuery.data.items.filter(
    (c) => c.kind === "sharepoint" && c.enabled,
  );
  const selectedConnection = connectionDraft ?? (settings.connectionPublicId ?? "__none__");
  const effectiveListId = listIdDraft ?? settings.listId ?? "";
  const effectiveListLabel = listLabelDraft ?? settings.listLabel ?? "";
  const effectivePortalLink = portalLinkDraft ?? settings.includePortalLink;
  const effectiveEnabled = enabledDraft ?? settings.enabled;

  const stateBadge = (() => {
    switch (settings.state) {
      case "ready":
        return <Badge tone="success">Active</Badge>;
      case "error":
        return <Badge tone="danger">Attention required</Badge>;
      case "not_configured":
        return <Badge tone="warning">Setup incomplete</Badge>;
      default:
        return <Badge tone="neutral">Disabled</Badge>;
    }
  })();

  const handleSaveConnectionAssignment = async () => {
    setSavingAssignment(true);
    try {
      await stepUp.run(
        () =>
          storageClient.setAssignment({
            purpose: "order_data",
            connectionPublicIds: selectedConnection === "__none__" ? [] : [selectedConnection],
          }),
        { reason: "Assigning the SharePoint order-data connection requires verification." },
      );
      setConnectionDraft(null);
      setLists(null);
      toast.show({ tone: "success", title: "SharePoint order-data connection updated" });
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Could not update SharePoint assignment",
        description: errorMessage(err),
      });
    } finally {
      setSavingAssignment(false);
    }
  };

  const handleLoadLists = async () => {
    setLoadingLists(true);
    try {
      const res = await stepUp.run(() => storageClient.listOrderSyncLists(), {
        reason: "Listing SharePoint site lists requires verification.",
      });
      setLists(res.lists);
      toast.show({ tone: "info", title: `Loaded ${res.lists.length} SharePoint lists` });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Could not load SharePoint lists",
        description: errorMessage(err),
      });
    } finally {
      setLoadingLists(false);
    }
  };

  const handleCreateList = async () => {
    const trimmed = newListName.trim();
    if (!trimmed || trimmed.length > 120 || INVALID_LIST_NAME_RE.test(trimmed)) {
      setNewListError("Enter a list name up to 120 characters without # % * : < > ? / \\ | or quotes.");
      return;
    }
    setNewListError(undefined);
    setCreatingList(true);
    try {
      const created = await stepUp.run(() => storageClient.createOrderSyncList({ displayName: trimmed }), {
        reason: "Creating a SharePoint list requires verification.",
      });
      setListIdDraft(created.listId);
      setListLabelDraft(created.displayName);
      setNewListName("");
      setLists((prev) => [
        ...(prev ?? []),
        { listId: created.listId, displayName: created.displayName, compatible: true },
      ]);
      toast.show({ tone: "success", title: `Created compatible list "${created.displayName}"` });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Could not create SharePoint list",
        description: errorMessage(err),
      });
    } finally {
      setCreatingList(false);
    }
  };

  const handleTestSync = async () => {
    setTesting(true);
    try {
      const res = await stepUp.run(() => storageClient.testOrderSync(), {
        reason: "Testing SharePoint list sync requires verification.",
      });
      setTestResult(res);
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "SharePoint sync test failed",
        description: errorMessage(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      await stepUp.run(
        () =>
          storageClient.updateOrderSync({
            expectedVersion: settings.version,
            enabled: effectiveEnabled,
            listId: effectiveListId || null,
            listLabel: effectiveListLabel || null,
            includePortalLink: effectivePortalLink,
          }),
        { reason: "Saving SharePoint order sync settings requires verification." },
      );
      setListIdDraft(null);
      setListLabelDraft(null);
      setPortalLinkDraft(null);
      setEnabledDraft(null);
      toast.show({ tone: "success", title: "SharePoint order sync settings saved" });
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Could not save SharePoint sync settings",
        description: errorMessage(err),
      });
    } finally {
      setSavingSettings(false);
    }
  };

  const handleBackfill = async (restart = false) => {
    setRunningBackfill(true);
    try {
      const updated = await stepUp.run(
        () => storageClient.backfillOrders(restart ? { restart: true } : {}),
        { reason: "Backfilling existing orders to SharePoint requires verification." },
      );
      toast.show({
        tone: "success",
        title: restart ? "SharePoint order backfill restarted" : "SharePoint order backfill started",
        description:
          updated.backfill?.enqueued !== undefined
            ? `${updated.backfill.enqueued} orders staged so far.`
            : undefined,
      });
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Could not start SharePoint backfill",
        description: errorMessage(err),
      });
    } finally {
      setRunningBackfill(false);
    }
  };

  const handleResyncStaged = async () => {
    setRunningResync(true);
    try {
      const res = await stepUp.run(() => storageClient.resyncAllOrders(), {
        reason: "Re-syncing orders to SharePoint requires verification.",
      });
      toast.show({
        tone: "success",
        title: `Queued ${res.enqueued} orders for SharePoint sync`,
      });
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Could not queue order re-sync",
        description: errorMessage(err),
      });
    } finally {
      setRunningResync(false);
    }
  };

  const statusColumns: Column<OrderSyncStatusRow>[] = [
    {
      key: "order",
      header: "Order",
      primary: true,
      cell: (row) => (
        <div>
          <p className="font-medium text-ink">{row.reference ?? row.orderPublicId}</p>
          <p className="font-mono text-xs text-muted">{row.orderPublicId}</p>
        </div>
      ),
    },
    {
      key: "state",
      header: "Sync state",
      cell: (row) => (
        <Badge
          tone={
            row.state === "synced"
              ? "success"
              : row.state === "failed"
                ? "danger"
                : "warning"
          }
        >
          {row.state === "synced"
            ? "Synced"
            : row.state === "failed"
              ? "Failed"
              : row.state === "unknown"
                ? "Outcome unknown"
                : "Pending"}
        </Badge>
      ),
    },
    {
      key: "attempts",
      header: "Attempts",
      cell: (row) => <span className="text-sm text-body">{row.attempts}</span>,
    },
    {
      key: "lastSynced",
      header: "Last synced",
      cell: (row) =>
        row.lastSyncedAt ? (
          <DateTime value={row.lastSyncedAt} />
        ) : (
          <span className="text-xs text-muted">Not synced yet</span>
        ),
    },
    {
      key: "reason",
      header: "Diagnostic code",
      cell: (row) =>
        row.reasonCode ? (
          <span className="font-mono text-xs text-danger">{row.reasonCode}</span>
        ) : (
          <span className="text-xs text-muted">—</span>
        ),
    },
  ];

  const backfill = settings.backfill ?? null;

  return (
    <>
      <PageHeader
        title="SharePoint order sync"
        description="One-way mirror of ReadyPackets order rows into a compatible Microsoft 365 SharePoint list. The portal database always remains the system of record."
        meta={stateBadge}
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link href="/admin/storage">Storage connections</Link>
          </Button>
        }
      />

      <div className="flex min-w-0 flex-col gap-6">
        {settings.lastError ? (
          <Callout tone="danger" title="Recent SharePoint sync error" live="polite">
            <p>
              Diagnostic code: <code className="font-mono">{settings.lastError.reasonCode}</code> (recorded{" "}
              <DateTime value={settings.lastError.at} />
              ).
            </p>
          </Callout>
        ) : null}

        {/* Card 1: Connection assignment */}
        <Card
          title="SharePoint site connection"
          description="Select an enabled SharePoint library connection to supply the target SharePoint site and Entra credentials."
        >
          <div className="flex flex-col gap-4">
            <KeyValueList
              items={[
                { label: "Target site", value: settings.siteLabel ?? "No SharePoint connection assigned" },
                { label: "Pending orders", value: String(settings.counts.pending) },
                { label: "Synced orders", value: String(settings.counts.synced) },
                { label: "Failed orders", value: String(settings.counts.failed) },
              ]}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:items-end">
              <Field label="Assigned SharePoint connection">
                <Select
                  value={selectedConnection}
                  onChange={(e) => setConnectionDraft(e.target.value)}
                  options={[
                    { value: "__none__", label: "None (disabled)" },
                    ...sharepointConnections.map((c) => ({ value: c.publicId, label: c.name })),
                  ]}
                />
              </Field>
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  loading={savingAssignment}
                  onClick={() => void handleSaveConnectionAssignment()}
                >
                  Save site assignment
                </Button>
              </div>
            </div>
          </div>
        </Card>

        {/* Card 2: Target SharePoint list & sync settings */}
        <Card
          title="SharePoint list & sync options"
          description="Choose an existing compatible list or provision a new list with ReadyPackets order columns (RpOrderId, status, dates, customer reference, and optional portal link)."
        >
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                loading={loadingLists}
                disabled={!settings.connectionPublicId}
                onClick={() => void handleLoadLists()}
              >
                Load site lists
              </Button>
              {effectiveListLabel ? (
                <span className="text-sm text-body">
                  Current list: <strong>{effectiveListLabel}</strong>
                </span>
              ) : null}
            </div>

            {lists ? (
              <Field
                label="Select existing compatible SharePoint list"
                hint="Lists missing required ReadyPackets columns are marked incompatible."
              >
                <Select
                  value={effectiveListId || "__none__"}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "__none__") {
                      setListIdDraft("");
                      setListLabelDraft("");
                      return;
                    }
                    const chosen = lists.find((l) => l.listId === val);
                    if (chosen && !chosen.compatible) {
                      toast.show({
                        tone: "warning",
                        title: "Selected list is missing required ReadyPackets columns",
                      });
                      return;
                    }
                    setListIdDraft(val);
                    setListLabelDraft(chosen?.displayName ?? "");
                  }}
                  options={[
                    { value: "__none__", label: "Choose a list…" },
                    ...lists.map((l) => ({
                      value: l.listId,
                      label: l.compatible ? l.displayName : `${l.displayName} (incompatible)`,
                    })),
                  ]}
                />
              </Field>
            ) : null}

            <div className="grid grid-cols-1 gap-3 rounded-[var(--radius-card)] border border-line p-4 sm:grid-cols-3 sm:items-end">
              <div className="sm:col-span-2">
                <Field
                  label="Or create a new compatible SharePoint list"
                  hint="Creates the list and required columns on the assigned SharePoint site."
                  error={newListError}
                >
                  <Input
                    value={newListName}
                    maxLength={120}
                    placeholder="ReadyPackets Orders"
                    onChange={(e) => setNewListName(e.target.value)}
                  />
                </Field>
              </div>
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  loading={creatingList}
                  disabled={!settings.connectionPublicId}
                  onClick={() => void handleCreateList()}
                >
                  Create compatible list
                </Button>
              </div>
            </div>

            <Switch
              label="Include direct portal link column on synced SharePoint items"
              description="Writes the administrator order URL without query secrets."
              checked={effectivePortalLink}
              onCheckedChange={(checked) => setPortalLinkDraft(checked)}
            />

            <Switch
              label="Enable automatic SharePoint order sync"
              description="Requires an assigned SharePoint connection and a compatible list that passes the connection test."
              checked={effectiveEnabled}
              disabled={!settings.connectionPublicId || !effectiveListId}
              onCheckedChange={(checked) => setEnabledDraft(checked)}
            />

            {testResult ? (
              <Callout
                tone={testResult.ok ? "success" : "danger"}
                title={testResult.ok ? "SharePoint list verified" : "SharePoint list check failed"}
                live="polite"
              >
                <p>{ORDER_SYNC_TEST_CODE_LABELS[testResult.code]}</p>
              </Callout>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                loading={testing}
                disabled={!settings.connectionPublicId}
                onClick={() => void handleTestSync()}
              >
                Test list sync
              </Button>
              <Button
                type="button"
                loading={savingSettings}
                onClick={() => void handleSaveSettings()}
              >
                Save sync settings
              </Button>
            </div>
          </div>
        </Card>

        {/* Card 3: Backfill & Re-sync operations */}
        <Card
          title="Backfill & re-sync operations"
          description="Stage existing portal orders into the SharePoint list without duplicating items (matched idempotently by RpOrderId)."
        >
          <div className="flex flex-col gap-4">
            {backfill ? (
              <Callout
                tone={
                  backfill.state === "completed"
                    ? "success"
                    : backfill.state === "failed"
                      ? "danger"
                      : "info"
                }
                title={
                  backfill.state === "running"
                    ? "Backfill in progress"
                    : backfill.state === "completed"
                      ? "Backfill completed"
                      : "Backfill paused with an error"
                }
                live="polite"
              >
                <p>
                  Orders staged: <strong>{backfill.enqueued}</strong>
                  {backfill.startedAt ? (
                    <>
                      {" "}
                      · Started <DateTime value={backfill.startedAt} />
                    </>
                  ) : null}
                  {backfill.finishedAt ? (
                    <>
                      {" "}
                      · Finished <DateTime value={backfill.finishedAt} />
                    </>
                  ) : null}
                  {backfill.reasonCode ? ` · Code: ${backfill.reasonCode}` : ""}
                </p>
              </Callout>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {backfill?.state === "failed" ? (
                <>
                  <Button
                    type="button"
                    loading={runningBackfill}
                    disabled={!settings.enabled}
                    onClick={() => void handleBackfill(false)}
                  >
                    Resume
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    loading={runningBackfill}
                    disabled={!settings.enabled}
                    onClick={() => void handleBackfill(true)}
                  >
                    Restart
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  loading={runningBackfill || backfill?.state === "running"}
                  disabled={!settings.enabled || backfill?.state === "running"}
                  onClick={() => void handleBackfill(false)}
                >
                  Sync all existing orders now
                </Button>
              )}

              <Button
                type="button"
                variant="secondary"
                loading={runningResync}
                disabled={!settings.enabled}
                onClick={() => void handleResyncStaged()}
              >
                Re-sync tracked orders
              </Button>
            </div>
            {!settings.enabled ? (
              <p className="text-xs text-muted">
                Save and enable SharePoint order sync above before running a backfill.
              </p>
            ) : null}
          </div>
        </Card>

        {/* Card 4: Per-order sync status */}
        <Card
          title="Per-order sync status"
          description="Tracks each staged order's delivery state and diagnostic codes."
          actions={
            <div className="w-44">
              <Field label="Filter order sync state" hideLabel>
                <Select
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(e.target.value as "all" | SharePointSyncRowState);
                    setCursor(null);
                  }}
                  options={[
                    { value: "all", label: "All states" },
                    { value: "pending", label: "Pending" },
                    { value: "synced", label: "Synced" },
                    { value: "failed", label: "Failed" },
                    { value: "unknown", label: "Outcome unknown" },
                  ]}
                />
              </Field>
            </div>
          }
        >
          {statusQuery.data.items.length === 0 ? (
            <EmptyState
              title="No order sync rows recorded yet"
              description="Once SharePoint order sync is enabled, newly changed or backfilled orders appear here."
            />
          ) : (
            <div className="flex flex-col gap-4">
              <DataTable
                columns={statusColumns}
                rows={statusQuery.data.items}
                rowKey={(row) => row.orderPublicId}
                caption="SharePoint order sync status"
              />
              <LoadMore
                hasMore={Boolean(statusQuery.data.nextCursor)}
                loading={statusQuery.isFetching}
                onLoadMore={() => setCursor(statusQuery.data?.nextCursor ?? null)}
              />
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
