/**
 * Console-only order tab ("SharePoint sync (n)" / "File sync (n)", key "sync", order 60).
 * Owner: recovery_ops_engineer (Increment 04 Part B, Package W client / Decision B7).
 *
 * Security & role-isolation invariants:
 *  - Registered with `access: "staff"` and guarded defensively (`area === "console"` +
 *    `orders.read_all`); customers never see the tab and never issue `storage.copies.forOrder`.
 *  - "Retry" is offered only when `state === "failed"`, `canRetry === true` (local source exists),
 *    and the signed-in console user holds `files.manage` (no step-up prompt required).
 *  - "Open Copy log" (`/admin/storage/copies?orderPublicId=<orderId>`) is shown only when the
 *    signed-in user holds `storage.copies.read`.
 *  - Empty state when no storage connection is assigned links administrators (`storage.manage`)
 *    to `/admin/storage` and gives plain-text guidance to staff without broken admin links.
 */
import type { inferRouterOutputs } from "@trpc/server";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, ExternalLink, HardDrive, HardDriveDownload } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import type { AppRouter } from "@server/trpc/root";
import { roleHasCapability } from "@shared/capabilities";
import { useSession } from "@/lib/session";
import { errorMessage, useTRPC } from "@/lib/trpc";
import {
  Badge,
  Button,
  buttonClasses,
  Callout,
  DateTime,
  EmptyState,
  ErrorState,
  LoadMore,
  Section,
  Skeleton,
  StatCard,
  StatGrid,
  useToast,
  type Tone,
} from "@/ui";
import type { StorageProviderKind } from "./model";

export type OrderFileSyncPage = inferRouterOutputs<AppRouter>["storage"]["copies"]["forOrder"];
export type OrderFileSyncItem = OrderFileSyncPage["items"][number];
export type OrderFileSyncState = OrderFileSyncItem["state"];
export type OrderFileSyncTotals = OrderFileSyncPage["totals"];

export interface OrderFileSyncTabProps {
  orderId: string;
  area: "customer" | "console";
}

const STATE_META: Record<OrderFileSyncState, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "info" },
  copying: { label: "Copying", tone: "info" },
  written: { label: "Written", tone: "info" },
  verified: { label: "Verified", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  not_written: { label: "Not written", tone: "neutral" },
};

const PROVIDER_LABELS: Record<StorageProviderKind, string> = {
  sharepoint: "SharePoint",
  onedrive: "OneDrive for Business",
  s3: "S3-compatible",
  azure_blob: "Azure Blob Storage",
  dropbox: "Dropbox",
  google_drive: "Google Drive",
};

function useOrderFileSyncPages(orderId: string, enabled: boolean) {
  const trpc = useTRPC();
  return useInfiniteQuery(
    trpc.storage.copies.forOrder.infiniteQueryOptions(
      { orderPublicId: orderId },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
        enabled,
        staleTime: 30_000,
      },
    ),
  );
}

function fileDisplayName(row: OrderFileSyncItem): string {
  const trimmed = row.fileName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : row.filePublicId;
}

function destinationLabel(row: OrderFileSyncItem): string {
  const trimmed = row.connectionName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : row.connectionPublicId;
}

/**
 * Dynamic text-only tab label ("SharePoint sync (n)" or "File sync (n)").
 * Never runs a query for customers or sessions without `orders.read_all`.
 */
export function OrderFileSyncTabLabel({ orderId, area }: OrderFileSyncTabProps) {
  const { view } = useSession();
  const canRead =
    area === "console" &&
    Boolean(orderId) &&
    view.status === "full" &&
    roleHasCapability(view.role, "orders.read_all");
  const query = useOrderFileSyncPages(orderId, canRead);

  if (!canRead) return null;
  const firstPage = query.data?.pages[0];
  if (!firstPage) return "File sync";
  const prefix = firstPage.hasSharePoint ? "SharePoint sync" : "File sync";
  return `${prefix} (${firstPage.totals.total})`;
}

export function OrderFileSyncTab({ orderId, area }: OrderFileSyncTabProps) {
  const { view } = useSession();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

  const canRead =
    area === "console" &&
    Boolean(orderId) &&
    view.status === "full" &&
    roleHasCapability(view.role, "orders.read_all");

  const query = useOrderFileSyncPages(orderId, canRead);
  const retryMutation = useMutation(trpc.storage.copies.retryOrderFile.mutationOptions());

  // Never render anything in the customer area or for sessions lacking `orders.read_all`.
  if (area !== "console") return null;
  if (view.status === "loading") {
    return (
      <div role="status" aria-label="Loading file sync" className="flex flex-col gap-3 py-2">
        <Skeleton className="h-20" />
        <Skeleton className="h-32" />
        <span className="sr-only">Loading file sync</span>
      </div>
    );
  }
  if (view.status !== "full" || !roleHasCapability(view.role, "orders.read_all")) {
    return null;
  }

  const canManageFiles = roleHasCapability(view.role, "files.manage");
  const canReadCopyLog = roleHasCapability(view.role, "storage.copies.read");
  const canManageStorage = roleHasCapability(view.role, "storage.manage");

  const firstPage = query.data?.pages[0];
  if (query.isError && !firstPage) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  if (query.isPending && !firstPage) {
    return (
      <div role="status" aria-label="Loading file sync transfers" className="flex flex-col gap-4 py-2">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-40" />
        <span className="sr-only">Loading file sync transfers</span>
      </div>
    );
  }

  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const totals: OrderFileSyncTotals = firstPage?.totals ?? {
    total: 0,
    synced: 0,
    inProgress: 0,
    failed: 0,
  };
  const hasSharePoint = firstPage?.hasSharePoint ?? false;
  const hasAssignedConnection =
    firstPage?.hasAssignedConnection ?? (hasSharePoint || totals.total > 0);
  const sectionTitle = hasSharePoint ? "SharePoint sync" : "File sync";
  const copyLogHref = `/admin/storage/copies?orderPublicId=${encodeURIComponent(orderId)}`;

  async function handleRetry(row: OrderFileSyncItem) {
    setRetryError(null);
    setRetryingId(row.publicId);
    try {
      const result = await retryMutation.mutateAsync({
        orderPublicId: orderId,
        publicId: row.publicId,
      });
      await queryClient.invalidateQueries({ queryKey: trpc.storage.copies.pathKey() });
      toast.show({
        tone: result.queued ? "success" : "info",
        title: result.queued
          ? `Retry queued for ${fileDisplayName(row)}.`
          : `Transfer for ${fileDisplayName(row)} is already queued or completed.`,
      });
    } catch (err) {
      setRetryError(errorMessage(err));
    } finally {
      setRetryingId(null);
    }
  }

  function renderFileCell(row: OrderFileSyncItem) {
    if (row.fileName && row.fileName.trim().length > 0) {
      return (
        <div className="min-w-0">
          <div className="font-medium break-words text-ink">{row.fileName}</div>
          <div className="font-mono text-xs break-all text-muted">{row.filePublicId}</div>
        </div>
      );
    }
    return <span className="font-mono text-xs break-all text-ink">{row.filePublicId}</span>;
  }

  function renderDestinationCell(row: OrderFileSyncItem) {
    const providerText = row.provider ? PROVIDER_LABELS[row.provider] ?? row.provider : null;
    return (
      <div className="min-w-0">
        <div className="font-medium break-words text-ink">{destinationLabel(row)}</div>
        {providerText ? <div className="text-xs text-muted">{providerText}</div> : null}
      </div>
    );
  }

  function renderTargetPath(row: OrderFileSyncItem) {
    if (!row.targetPath) return <span className="text-muted">—</span>;
    return (
      <code className="block max-w-[22rem] font-mono text-xs break-all whitespace-normal text-body">
        {row.targetPath}
      </code>
    );
  }

  function renderAction(row: OrderFileSyncItem) {
    if (row.state === "failed" && row.canRetry && canManageFiles) {
      const busy = retryingId === row.publicId;
      return (
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          disabled={retryingId !== null && !busy}
          onClick={() => void handleRetry(row)}
          aria-label={`Retry sync for ${fileDisplayName(row)}`}
        >
          Retry
        </Button>
      );
    }
    if (row.state === "failed" && !row.canRetry) {
      return <span className="text-xs text-muted">Source unavailable</span>;
    }
    return <span className="text-xs text-muted">—</span>;
  }

  return (
    <Section
      id="order-file-sync"
      title={sectionTitle}
      description="Outbound copies of order uploads, saved recordings, and converted audio. Local object storage remains the system of record."
      actions={
        canReadCopyLog ? (
          <Link href={copyLogHref} className={buttonClasses("secondary", "sm")}>
            <ExternalLink aria-hidden="true" />
            Open Copy log
          </Link>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        {retryError ? (
          <Callout tone="danger" title="Could not queue retry" live="assertive">
            {retryError}
          </Callout>
        ) : null}

        {!hasAssignedConnection && rows.length > 0 ? (
          <Callout tone="warning" title="No active storage connection is assigned">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>
                Historical transfers are shown below, but no storage connection is currently assigned to order files.
                New files stay in local storage until a connection is assigned.
              </span>
              {canManageStorage ? (
                <Link href="/admin/storage" className={buttonClasses("secondary", "sm")}>
                  Configure storage connections
                </Link>
              ) : null}
            </div>
          </Callout>
        ) : null}

        <StatGrid label={`${sectionTitle} totals`}>
          <StatCard label="Total" value={totals.total} icon={HardDriveDownload} tone="neutral" />
          <StatCard label="Synced" value={totals.synced} icon={CheckCircle2} tone="success" />
          <StatCard label="In progress" value={totals.inProgress} icon={Clock} tone="info" />
          <StatCard
            label="Failed"
            value={totals.failed}
            icon={AlertTriangle}
            tone={totals.failed > 0 ? "danger" : "neutral"}
          />
        </StatGrid>

        {rows.length === 0 ? (
          !hasAssignedConnection ? (
            <EmptyState
              headingLevel={3}
              icon={HardDrive}
              title="No storage connection is assigned"
              description={
                canManageStorage
                  ? "No SharePoint library, OneDrive, or other storage connection is assigned to order files yet. Local object storage remains the system of record; assign a connection to sync order files automatically."
                  : "No storage connection is assigned to order files yet. Local object storage remains the system of record; an administrator can assign an order-file destination in Storage connections."
              }
              action={
                canManageStorage ? (
                  <Link href="/admin/storage" className={buttonClasses("secondary", "md")}>
                    Configure storage connections
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <EmptyState
              headingLevel={3}
              icon={HardDriveDownload}
              title="No file transfers yet"
              description="Uploads, saved recordings, and converted audio files on this order will copy automatically to the assigned storage destination."
            />
          )
        ) : (
          <div className="flex flex-col gap-3" aria-busy={query.isFetching || undefined}>
            {/* Table at >= 640 px (Tailwind `sm`). Focusable scroll region satisfies WCAG 2.1.1 / axe scrollable-region-focusable. */}
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
            <div tabIndex={0} role="region" aria-label="Order file transfers table" className="hidden overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-card)] sm:block rp-forced-border">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">Order file transfers</caption>
                <thead className="bg-surface-soft">
                  <tr>
                    <th scope="col" className="border-b border-line px-4 py-2.5 text-xs font-semibold tracking-wide text-muted uppercase">
                      File
                    </th>
                    <th scope="col" className="border-b border-line px-4 py-2.5 text-xs font-semibold tracking-wide text-muted uppercase">
                      Phase
                    </th>
                    <th scope="col" className="border-b border-line px-4 py-2.5 text-xs font-semibold tracking-wide text-muted uppercase">
                      Status
                    </th>
                    <th scope="col" className="border-b border-line px-4 py-2.5 text-xs font-semibold tracking-wide text-muted uppercase">
                      Destination
                    </th>
                    <th scope="col" className="border-b border-line px-4 py-2.5 text-xs font-semibold tracking-wide text-muted uppercase">
                      Target path
                    </th>
                    <th scope="col" className="border-b border-line px-4 py-2.5 text-xs font-semibold tracking-wide text-muted uppercase">
                      Last update
                    </th>
                    <th scope="col" className="border-b border-line px-4 py-2.5 text-right text-xs font-semibold tracking-wide text-muted uppercase">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const statusMeta = STATE_META[row.state];
                    return (
                      <tr key={row.publicId} className="border-b border-line last:border-b-0 hover:bg-surface-soft">
                        <td className="px-4 py-3 align-top text-ink">{renderFileCell(row)}</td>
                        <td className="px-4 py-3 align-top break-words text-ink">{row.phase ?? "—"}</td>
                        <td className="px-4 py-3 align-top whitespace-nowrap">
                          <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
                        </td>
                        <td className="px-4 py-3 align-top text-ink">{renderDestinationCell(row)}</td>
                        <td className="px-4 py-3 align-top text-ink">{renderTargetPath(row)}</td>
                        <td className="px-4 py-3 align-top whitespace-nowrap text-ink">
                          <DateTime value={row.updatedAt} format="datetime" />
                        </td>
                        <td className="px-4 py-3 text-right align-top whitespace-nowrap">{renderAction(row)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Stacked cards below 640 px (`sm:hidden`). */}
            <ul aria-label="Order file transfers" className="flex flex-col gap-3 sm:hidden">
              {rows.map((row) => {
                const statusMeta = STATE_META[row.state];
                const showFooterAction = row.state === "failed" && ((row.canRetry && canManageFiles) || !row.canRetry);
                return (
                  <li
                    key={row.publicId}
                    className="rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-[var(--shadow-card)] rp-forced-border"
                  >
                    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">{renderFileCell(row)}</div>
                      <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
                    </div>
                    <dl className="grid grid-cols-[minmax(6.5rem,auto)_1fr] gap-x-3 gap-y-1.5 text-sm">
                      <div className="contents">
                        <dt className="text-muted">Phase</dt>
                        <dd className="min-w-0 break-words text-ink">{row.phase ?? "—"}</dd>
                      </div>
                      <div className="contents">
                        <dt className="text-muted">Destination</dt>
                        <dd className="min-w-0 break-words text-ink">{renderDestinationCell(row)}</dd>
                      </div>
                      <div className="contents">
                        <dt className="text-muted">Target path</dt>
                        <dd className="min-w-0 text-ink">
                          {row.targetPath ? (
                            <code className="block font-mono text-xs break-all whitespace-normal text-body">
                              {row.targetPath}
                            </code>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </dd>
                      </div>
                      <div className="contents">
                        <dt className="text-muted">Last update</dt>
                        <dd className="min-w-0 text-ink">
                          <DateTime value={row.updatedAt} format="datetime" />
                        </dd>
                      </div>
                    </dl>
                    {showFooterAction ? (
                      <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
                        {renderAction(row)}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            <LoadMore
              hasMore={Boolean(query.hasNextPage)}
              loading={query.isFetchingNextPage}
              onLoadMore={() => void query.fetchNextPage()}
            />
          </div>
        )}
      </div>
    </Section>
  );
}

export default OrderFileSyncTab;
