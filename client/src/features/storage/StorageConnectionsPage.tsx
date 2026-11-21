/**
 * Storage connections administration page (/admin/storage).
 *
 * Covers:
 *   - Two-step OAuth callback completion (?oauth=finish#oauth-attempt=<43-char-handle> ->
 *     immediate URL cleanup -> GET /api/csrf -> POST /api/storage/oauth/finish)
 *   - Connections table across all 9 provider choices with test, enable/disable,
 *     OAuth Connect/Disconnect (with explicit remoteRevoked: false guidance), and edit
 *   - Purpose assignments for Order files (up to 8), Off-site backups (up to 8),
 *     and SharePoint order data (single SharePoint connection)
 *   - Outbound allowlist preset quick toggles for cloud storage hosts
 */
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "@/lib/trpc";
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  DataTable,
  DateTime,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  StepUpCancelledError,
  Switch,
  useStepUp,
  useToast,
  type Column,
} from "@/ui";
import { useStorageApi, useStorageDirectClient, type OAuthProvider } from "./api";
import {
  describeConnectionStatus,
  describeEgressPreset,
  parseOAuthAttemptHandle,
  PURPOSE_META,
  resolveProviderChoice,
  STORAGE_TEST_CODE_LABELS,
  type EgressPresetKey,
  type EgressPresetView,
  type StorageConnectionView,
  type StoragePurpose,
} from "./model";

// Module-level guard prevents React StrictMode double-invocation from consuming or failing
// a single-use OAuth attempt handle after history.replaceState strips the URL fragment.
const consumedOAuthHandles = new Set<string>();

/** Reset helper for isolated component tests. */
export function resetConsumedOAuthHandlesForTest(): void {
  consumedOAuthHandles.clear();
}

export function StorageConnectionsPage() {
  const api = useStorageApi();
  const storageClient = useStorageDirectClient();
  const queryClient = useQueryClient();
  const stepUp = useStepUp();
  const toast = useToast();
  const [, navigate] = useLocation();
  const routerSearch = useSearch();

  const connectionsQuery = useQuery(api.connectionsList.queryOptions({ limit: 100 }));
  const assignmentsQuery = useQuery(api.assignmentsList.queryOptions());
  const egressQuery = useQuery(api.egressPresets.queryOptions());

  const [initialOAuth] = useState<
    | { kind: "none" }
    | { kind: "connected" }
    | { kind: "failed" }
    | { kind: "finish"; handle: string }
  >(() => {
    const searchParams = new URLSearchParams(routerSearch || window.location.search);
    const oauthParam = searchParams.get("oauth");
    if (!oauthParam) return { kind: "none" };
    if (oauthParam === "connected") return { kind: "connected" };
    if (oauthParam !== "finish") return { kind: "failed" };
    const handle = parseOAuthAttemptHandle(window.location.hash);
    if (!handle) return { kind: "failed" };
    return { kind: "finish", handle };
  });

  const [oauthBanner, setOauthBanner] = useState<
    | { kind: "finishing" }
    | { kind: "connected" }
    | { kind: "failed" }
    | { kind: "remote_not_revoked"; providerLabel: string }
    | null
  >(() => {
    if (initialOAuth.kind === "connected") return { kind: "connected" };
    if (initialOAuth.kind === "failed") return { kind: "failed" };
    if (initialOAuth.kind === "finish") return { kind: "finishing" };
    return null;
  });

  const [busyRowId, setBusyRowId] = useState<string | null>(null);
  const [savingPurpose, setSavingPurpose] = useState<StoragePurpose | null>(null);
  const [orderFilesDraft, setOrderFilesDraft] = useState<string[] | null>(null);
  const [backupsDraft, setBackupsDraft] = useState<string[] | null>(null);
  const [orderDataDraft, setOrderDataDraft] = useState<string | null>(null);

  const [presetRegion, setPresetRegion] = useState("us-east-1");
  const [presetBucket, setPresetBucket] = useState("");
  const [presetAccount, setPresetAccount] = useState("");
  const [togglingPreset, setTogglingPreset] = useState<EgressPresetKey | null>(null);

  const handledOAuthCallbackRef = useRef(false);

  const refreshAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: api.connectionsList.queryKey() }),
      queryClient.invalidateQueries({ queryKey: api.assignmentsList.queryKey() }),
      queryClient.invalidateQueries({ queryKey: api.egressPresets.queryKey() }),
    ]);
  };

  // Two-step OAuth callback completion (?oauth=finish#oauth-attempt=<43-char-handle>)
  useEffect(() => {
    if (initialOAuth.kind === "none" || handledOAuthCallbackRef.current) return;

    window.history.replaceState(null, "", "/admin/storage");
    navigate("/admin/storage", { replace: true });
    handledOAuthCallbackRef.current = true;

    if (initialOAuth.kind === "connected") {
      void queryClient.invalidateQueries({ queryKey: api.connectionsList.queryKey() });
      return;
    }
    if (initialOAuth.kind !== "finish") {
      return;
    }

    const { handle } = initialOAuth;
    if (consumedOAuthHandles.has(handle)) {
      return;
    }
    consumedOAuthHandles.add(handle);

    void (async () => {
      try {
        const res = await storageClient.finishOAuth(handle);
        if (res.connected) {
          setOauthBanner({ kind: "connected" });
          await queryClient.invalidateQueries({ queryKey: api.connectionsList.queryKey() });
        } else {
          setOauthBanner({ kind: "failed" });
        }
      } catch {
        setOauthBanner({ kind: "failed" });
      }
    })();
  }, [api.connectionsList, initialOAuth, navigate, queryClient, storageClient]);

  const anyError = connectionsQuery.error ?? assignmentsQuery.error ?? egressQuery.error;
  const anyPending =
    connectionsQuery.isPending || assignmentsQuery.isPending || egressQuery.isPending;

  if (anyError) {
    return (
      <>
        <PageHeader
          title="Storage connections"
          description="Configure external storage providers for order files, encrypted off-site backups, and SharePoint order sync."
        />
        <ErrorState
          error={anyError}
          title="Could not load storage connections"
          onRetry={() => {
            void connectionsQuery.refetch();
            void assignmentsQuery.refetch();
            void egressQuery.refetch();
          }}
        />
      </>
    );
  }

  if (anyPending || !connectionsQuery.data || !assignmentsQuery.data || !egressQuery.data) {
    return (
      <>
        <PageHeader
          title="Storage connections"
          description="Configure external storage providers for order files, encrypted off-site backups, and SharePoint order sync."
        />
        <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading storage connections">
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </>
    );
  }

  const connections = connectionsQuery.data.items;
  const assignments = assignmentsQuery.data;

  const assignedFor = (purpose: StoragePurpose) =>
    assignments.filter((a) => a.purpose === purpose).map((a) => a.connectionPublicId);

  const selectedOrderFiles = orderFilesDraft ?? assignedFor("order_files");
  const selectedBackups = backupsDraft ?? assignedFor("backups");
  const selectedOrderData = orderDataDraft ?? (assignedFor("order_data")[0] ?? "__none__");

  const handleTestConnection = async (conn: StorageConnectionView) => {
    setBusyRowId(conn.publicId);
    try {
      const updated = await stepUp.run(
        () => storageClient.testConnection({ publicId: conn.publicId, expectedVersion: conn.version }),
        { reason: "Testing a storage connection requires verification." },
      );
      const outcome = updated.lastTest;
      toast.show({
        tone: outcome?.ok ? "success" : "warning",
        title: outcome?.ok ? `${conn.name}: connection verified` : `${conn.name}: test did not pass`,
        description: outcome ? STORAGE_TEST_CODE_LABELS[outcome.code] : undefined,
      });
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Storage connection test failed",
        description: errorMessage(err),
      });
    } finally {
      setBusyRowId(null);
    }
  };

  const handleToggleEnabled = async (conn: StorageConnectionView, nextEnabled: boolean) => {
    setBusyRowId(conn.publicId);
    try {
      await stepUp.run(
        () =>
          storageClient.updateConnection({
            publicId: conn.publicId,
            expectedVersion: conn.version,
            enabled: nextEnabled,
          }),
        {
          reason: nextEnabled
            ? "Enabling a storage connection requires verification."
            : "Disabling a storage connection requires verification.",
        },
      );
      toast.show({
        tone: "success",
        title: nextEnabled ? `${conn.name} enabled` : `${conn.name} disabled`,
      });
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Could not update connection state",
        description: errorMessage(err),
      });
    } finally {
      setBusyRowId(null);
    }
  };

  const handleStartOAuth = async (conn: StorageConnectionView) => {
    if (conn.kind !== "dropbox" && conn.kind !== "google_drive") return;
    const provider: OAuthProvider = conn.kind;
    setBusyRowId(conn.publicId);
    try {
      const { authorizeUrl } = await stepUp.run(
        () =>
          storageClient.startOAuth({
            provider,
            publicId: conn.publicId,
            expectedVersion: conn.version,
          }),
        { reason: "Starting external storage OAuth authorization requires verification." },
      );
      window.location.assign(authorizeUrl);
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Could not start OAuth consent",
        description: errorMessage(err),
      });
    } finally {
      setBusyRowId(null);
    }
  };

  const handleDisconnectOAuth = async (conn: StorageConnectionView) => {
    if (conn.kind !== "dropbox" && conn.kind !== "google_drive") return;
    const provider: OAuthProvider = conn.kind;
    const providerLabel = resolveProviderChoice(conn.kind, conn.config).label;
    setBusyRowId(conn.publicId);
    try {
      const result = await stepUp.run(
        () =>
          storageClient.disconnectOAuth({
            provider,
            publicId: conn.publicId,
            expectedVersion: conn.version,
          }),
        { reason: "Disconnecting an OAuth storage grant requires verification." },
      );
      if (!result.remoteRevoked) {
        setOauthBanner({ kind: "remote_not_revoked", providerLabel });
      } else {
        toast.show({
          tone: "success",
          title: `${conn.name} OAuth grant disconnected and revoked`,
        });
      }
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Could not disconnect OAuth grant",
        description: errorMessage(err),
      });
    } finally {
      setBusyRowId(null);
    }
  };

  const handleSaveAssignment = async (purpose: StoragePurpose, ids: string[]) => {
    setSavingPurpose(purpose);
    try {
      await stepUp.run(
        () =>
          storageClient.setAssignment({
            purpose,
            connectionPublicIds: ids,
          }),
        { reason: "Updating storage purpose assignments requires verification." },
      );
      if (purpose === "order_files") setOrderFilesDraft(null);
      if (purpose === "backups") setBackupsDraft(null);
      if (purpose === "order_data") setOrderDataDraft(null);
      toast.show({
        tone: "success",
        title: `${PURPOSE_META[purpose].label} assignment saved`,
      });
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Could not save purpose assignment",
        description: errorMessage(err),
      });
    } finally {
      setSavingPurpose(null);
    }
  };

  const handleTogglePreset = async (preset: EgressPresetView, nextEnabled: boolean) => {
    const meta = describeEgressPreset(preset.key);
    const params: { region?: string; bucket?: string; accountName?: string } = {};
    if (nextEnabled) {
      if (meta.requiredParams.includes("region")) {
        if (!presetRegion.trim()) {
          toast.show({ tone: "warning", title: "Enter a cloud region before enabling this preset" });
          return;
        }
        params.region = presetRegion.trim();
      }
      if (meta.requiredParams.includes("bucket") && presetBucket.trim()) {
        params.bucket = presetBucket.trim();
      }
      if (meta.requiredParams.includes("accountName")) {
        if (!presetAccount.trim()) {
          toast.show({ tone: "warning", title: "Enter the Azure storage account name before enabling this preset" });
          return;
        }
        params.accountName = presetAccount.trim();
      }
    }
    setTogglingPreset(preset.key);
    try {
      await stepUp.run(
        () =>
          storageClient.setEgressPreset({
            presetKey: preset.key,
            enabled: nextEnabled,
            ...(Object.keys(params).length > 0 ? { params } : {}),
          }),
        { reason: "Updating outbound storage allowlist presets requires verification." },
      );
      toast.show({
        tone: "success",
        title: nextEnabled ? `${preset.label} allowlist enabled` : `${preset.label} allowlist disabled`,
      });
      await refreshAll();
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "Could not update outbound preset",
        description: errorMessage(err),
      });
    } finally {
      setTogglingPreset(null);
    }
  };

  const columns: Column<StorageConnectionView>[] = [
    {
      key: "name",
      header: "Connection",
      primary: true,
      cell: (row) => {
        const choice = resolveProviderChoice(row.kind, row.config);
        return (
          <div className="min-w-0">
            <p className="font-semibold text-ink break-words">{row.name}</p>
            <p className="text-xs text-muted">{choice.label}</p>
          </div>
        );
      },
    },
    {
      key: "status",
      header: "State",
      cell: (row) => {
        const status = describeConnectionStatus(row);
        const choice = resolveProviderChoice(row.kind, row.config);
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={status.tone}>{status.label}</Badge>
            {choice.usesOAuth ? (
              <Badge tone={row.oauthConnected ? "info" : "neutral"}>
                {row.oauthConnected ? "OAuth connected" : "OAuth disconnected"}
              </Badge>
            ) : null}
          </div>
        );
      },
    },
    {
      key: "lastTest",
      header: "Last check",
      cell: (row) =>
        row.lastTest ? (
          <div className="text-xs">
            <p className="font-medium text-ink">{STORAGE_TEST_CODE_LABELS[row.lastTest.code]}</p>
            <p className="text-muted">
              <DateTime value={row.lastTest.checkedAt} />
            </p>
          </div>
        ) : (
          <span className="text-xs text-muted">Never tested</span>
        ),
    },
    {
      key: "actions",
      header: "Actions",
      align: "end",
      cell: (row) => {
        const status = describeConnectionStatus(row);
        const choice = resolveProviderChoice(row.kind, row.config);
        const busy = busyRowId === row.publicId;
        return (
          <div className="flex flex-wrap justify-end gap-2">
            {choice.usesOAuth && row.credentialsConfigured ? (
              row.oauthConnected ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  loading={busy}
                  onClick={() => void handleDisconnectOAuth(row)}
                >
                  Disconnect
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  loading={busy}
                  onClick={() => void handleStartOAuth(row)}
                >
                  Connect
                </Button>
              )
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              loading={busy}
              disabled={!row.credentialsConfigured}
              onClick={() => void handleTestConnection(row)}
            >
              Test
            </Button>
            {row.enabled ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                loading={busy}
                onClick={() => void handleToggleEnabled(row, false)}
              >
                Disable
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                loading={busy}
                disabled={!status.canEnable}
                onClick={() => void handleToggleEnabled(row, true)}
              >
                Enable
              </Button>
            )}
            <Button asChild size="sm" variant="secondary">
              <Link href={`/admin/storage/${row.publicId}/edit`}>Edit</Link>
            </Button>
          </div>
        );
      },
    },
  ];

  const eligibleOrderFiles = connections.filter(
    (c) => c.enabled && resolveProviderChoice(c.kind, c.config).supportedPurposes.includes("order_files"),
  );
  const eligibleBackups = connections.filter(
    (c) => c.enabled && (c.kind === "s3" || c.kind === "azure_blob"),
  );
  const eligibleSharePoint = connections.filter((c) => c.enabled && c.kind === "sharepoint");

  const storagePresets = egressQuery.data.filter((p) => p.key !== "entra_oidc");

  return (
    <>
      <PageHeader
        title="Storage connections"
        description="Configure external storage providers using each provider's own credentials, verify connectivity, and assign enabled destinations to order files, off-site backups, and SharePoint order sync."
        meta={
          connections.some((c) => c.enabled) ? (
            <Badge tone="success">{connections.filter((c) => c.enabled).length} enabled</Badge>
          ) : (
            <Badge tone="neutral">All external copies disabled</Badge>
          )
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary" size="sm">
              <Link href="/admin/sharepoint-sync">SharePoint order sync</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/admin/storage/new">Add storage connection</Link>
            </Button>
          </div>
        }
      />

      <div className="flex min-w-0 flex-col gap-6">
        {oauthBanner?.kind === "finishing" ? (
          <Callout tone="info" title="Completing OAuth authorization" live="polite">
            <p>Verifying your portal session and exchanging the provider authorization grant.</p>
          </Callout>
        ) : null}
        {oauthBanner?.kind === "connected" ? (
          <Callout tone="success" title="OAuth authorization connected" live="polite">
            <p>
              The refresh token is stored encrypted. Click <strong>Test</strong> on the connection row, then{" "}
              <strong>Enable</strong> when ready.
            </p>
          </Callout>
        ) : null}
        {oauthBanner?.kind === "failed" ? (
          <Callout tone="danger" title="OAuth authorization could not be completed" live="assertive">
            <p>
              No tokens were saved. Confirm your session is active and your Redirect URI and outbound allowlist preset
              are enabled, then click <strong>Connect</strong> again to start a fresh consent window.
            </p>
          </Callout>
        ) : null}
        {oauthBanner?.kind === "remote_not_revoked" ? (
          <Callout
            tone="warning"
            title={`Local token cleared — revoke access in ${oauthBanner.providerLabel}`}
            live="assertive"
          >
            <p>
              ReadyPackets deleted its local OAuth token and disabled the connection, but the remote revocation call to{" "}
              {oauthBanner.providerLabel} did not confirm revocation. Sign in to your {oauthBanner.providerLabel}{" "}
              account security / connected apps console and revoke the ReadyPackets app grant directly.
            </p>
          </Callout>
        ) : null}

        {/* Connections Table */}
        <Card
          title="Configured destinations"
          description="The portal database and local primary file storage always remain authoritative. External destinations receive asynchronous verified copies only after testing and explicit enablement."
        >
          {connections.length === 0 ? (
            <EmptyState
              title="No external storage connections configured"
              description="Add Amazon S3, Wasabi, Backblaze B2, custom S3, Azure Blob Storage, Dropbox, Google Drive, SharePoint library, or OneDrive for Business."
              action={
                <Button asChild>
                  <Link href="/admin/storage/new">Add storage connection</Link>
                </Button>
              }
            />
          ) : (
            <DataTable
              columns={columns}
              rows={connections}
              rowKey={(row) => row.publicId}
              caption="Configured external storage connections"
            />
          )}
        </Card>

        {/* Purpose Assignments (Order files, Off-site backups, SharePoint order data) */}
        <Card
          title="Purpose assignments"
          description="Assign enabled connections to each portal workflow. Unassigned purposes stay local-only."
        >
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Order files */}
            <div className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-card)] border border-line p-4">
              <div>
                <h3 className="text-base font-semibold text-ink">{PURPOSE_META.order_files.label}</h3>
                <p className="mt-1 text-xs text-muted">{PURPOSE_META.order_files.description}</p>
              </div>
              {eligibleOrderFiles.length === 0 ? (
                <p className="text-sm text-muted">Enable at least one connection to assign order file destinations.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {eligibleOrderFiles.map((conn) => {
                    const checked = selectedOrderFiles.includes(conn.publicId);
                    return (
                      <Checkbox
                        key={conn.publicId}
                        label={`${conn.name} (${resolveProviderChoice(conn.kind, conn.config).label})`}
                        checked={checked}
                        onCheckedChange={(next) => {
                          const nextIds = next
                            ? [...selectedOrderFiles, conn.publicId].slice(0, 8)
                            : selectedOrderFiles.filter((id) => id !== conn.publicId);
                          setOrderFilesDraft(nextIds);
                        }}
                      />
                    );
                  })}
                </div>
              )}
              <div className="mt-auto pt-2">
                <Button
                  type="button"
                  size="sm"
                  loading={savingPurpose === "order_files"}
                  onClick={() => void handleSaveAssignment("order_files", selectedOrderFiles)}
                >
                  Save order files assignment
                </Button>
              </div>
            </div>

            {/* Off-site backups */}
            <div id="backups" className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-card)] border border-line p-4">
              <div>
                <h3 className="text-base font-semibold text-ink">{PURPOSE_META.backups.label}</h3>
                <p className="mt-1 text-xs text-muted">{PURPOSE_META.backups.description}</p>
              </div>
              {eligibleBackups.length === 0 ? (
                <p className="text-sm text-muted">
                  Enable an Amazon S3, Wasabi, Backblaze B2, custom S3, or Azure Blob connection to assign off-site
                  backup copies.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {eligibleBackups.map((conn) => {
                    const checked = selectedBackups.includes(conn.publicId);
                    return (
                      <Checkbox
                        key={conn.publicId}
                        label={`${conn.name} (${resolveProviderChoice(conn.kind, conn.config).label})`}
                        checked={checked}
                        onCheckedChange={(next) => {
                          const nextIds = next
                            ? [...selectedBackups, conn.publicId].slice(0, 8)
                            : selectedBackups.filter((id) => id !== conn.publicId);
                          setBackupsDraft(nextIds);
                        }}
                      />
                    );
                  })}
                </div>
              )}
              <div className="mt-auto pt-2">
                <Button
                  type="button"
                  size="sm"
                  loading={savingPurpose === "backups"}
                  onClick={() => void handleSaveAssignment("backups", selectedBackups)}
                >
                  Save backup destinations
                </Button>
              </div>
            </div>

            {/* SharePoint order data */}
            <div className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-card)] border border-line p-4">
              <div>
                <h3 className="text-base font-semibold text-ink">{PURPOSE_META.order_data.label}</h3>
                <p className="mt-1 text-xs text-muted">{PURPOSE_META.order_data.description}</p>
              </div>
              <Field label="Assigned SharePoint connection">
                <Select
                  value={selectedOrderData}
                  onChange={(e) => setOrderDataDraft(e.target.value)}
                  options={[
                    { value: "__none__", label: "None (disabled)" },
                    ...eligibleSharePoint.map((c) => ({ value: c.publicId, label: c.name })),
                  ]}
                />
              </Field>
              <div className="mt-auto flex flex-wrap gap-2 pt-2">
                <Button
                  type="button"
                  size="sm"
                  loading={savingPurpose === "order_data"}
                  onClick={() =>
                    void handleSaveAssignment(
                      "order_data",
                      selectedOrderData === "__none__" ? [] : [selectedOrderData],
                    )
                  }
                >
                  Save SharePoint assignment
                </Button>
                <Button asChild size="sm" variant="secondary">
                  <Link href="/admin/sharepoint-sync">Configure list sync</Link>
                </Button>
              </div>
            </div>
          </div>
        </Card>

        {/* Outbound Allowlist Presets */}
        <Card
          title="Provider outbound allowlist presets"
          description="ReadyPackets blocks outbound HTTPS traffic unless explicitly permitted. Enable presets for your chosen cloud providers, or manage custom S3 hostnames on the Outbound allowlist page."
          actions={
            <Button asChild size="sm" variant="secondary">
              <Link href="/admin/integrations/egress">Custom allowlist rules</Link>
            </Button>
          }
        >
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Cloud region (for S3 / Wasabi / Backblaze presets)" hint="Example: us-east-1">
                <Input value={presetRegion} onChange={(e) => setPresetRegion(e.target.value)} />
              </Field>
              <Field label="S3 bucket (optional virtual-host scope)" hint="Optional bucket name">
                <Input value={presetBucket} onChange={(e) => setPresetBucket(e.target.value)} />
              </Field>
              <Field label="Azure storage account (for Azure Blob preset)" hint="Example: readypacketsprod">
                <Input value={presetAccount} onChange={(e) => setPresetAccount(e.target.value)} />
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {storagePresets.map((preset) => {
                const meta = describeEgressPreset(preset.key);
                return (
                  <div
                    key={preset.key}
                    className="flex items-start justify-between gap-3 rounded-[var(--radius-card)] border border-line p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink">{preset.label}</p>
                      <p className="mt-0.5 text-xs text-muted">{meta.description}</p>
                      {preset.hosts.length > 0 ? (
                        <p className="mt-1 font-mono text-xs text-body break-all">
                          Active: {preset.hosts.join(", ")}
                        </p>
                      ) : null}
                    </div>
                    <Switch
                      label={`Allow ${preset.label}`}
                      checked={preset.enabled}
                      disabled={togglingPreset === preset.key}
                      onCheckedChange={(next) => void handleTogglePreset(preset, next)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
