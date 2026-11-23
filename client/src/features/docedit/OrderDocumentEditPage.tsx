/**
 * Portal Word (.docx) document view/edit & version screen (Increment 06 D9).
 * Holds draft content exclusively in React memory (never localStorage/sessionStorage/indexedDB).
 */
import { ArrowLeft, Download, FileSpreadsheet, History, RotateCcw, Save } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useParams, useSearch } from "wouter";
import type { FileRecord } from "@server/modules/files/index";
import {
  DOCX_MIME,
  DocConvertError,
  docxToHtml,
  editorToDocx,
  orderDocumentEditHref,
  type DocxUnsupportedFeature,
} from "@/lib/docconvert";
import { apiUrl } from "@/lib/runtime";
import { sessionFetch } from "@/lib/sessionTransport";
import { errorMessage, useTRPC, useTRPCClient } from "@/lib/trpc";
import {
  Badge,
  Breadcrumbs,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  DateTime,
  EmptyState,
  PageHeader,
  Section,
  Spinner,
  useToast,
} from "@/ui";

const DocumentEditorCanvas = lazy(() => import("./DocumentEditorCanvas"));

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TASK_KEY_RE = /^[a-z][a-z0-9_]{1,47}$/;

export interface OrderDocumentEditPageProps {
  readonly area: "customer" | "console";
}

interface LoadedDocumentState {
  readonly filePublicId: string;
  readonly baselineHtml: string;
  readonly warnings: readonly string[];
  readonly detectedUnsupported: readonly DocxUnsupportedFeature[];
}

type PendingLeaveAction =
  | { readonly kind: "navigate"; readonly href: string }
  | { readonly kind: "discard" };

function formatFileBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function ensureDocxFileName(name: string): string {
  const trimmed = name.trim() || "document.docx";
  return trimmed.toLowerCase().endsWith(".docx") ? trimmed : `${trimmed}.docx`;
}

function buildDocumentEndpoint(orderId: string, fileId: string, taskKey: string | undefined): string {
  const base = `/api/files/orders/${encodeURIComponent(orderId)}/${encodeURIComponent(fileId)}/document`;
  return taskKey ? `${base}?taskKey=${encodeURIComponent(taskKey)}` : base;
}

async function readHttpErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { message?: string; code?: string };
      message?: string;
    };
    if (typeof body?.error?.message === "string" && body.error.message.trim()) {
      return body.error.message;
    }
    if (typeof body?.message === "string" && body.message.trim()) {
      return body.message;
    }
  } catch {
    // Ignore non-JSON error bodies and return fallback.
  }
  return fallback;
}

export function OrderDocumentEditView({ area }: OrderDocumentEditPageProps) {
  const params = useParams<{ orderId?: string; fileId?: string }>();
  const orderId = params.orderId ?? "";
  const fileId = params.fileId ?? "";
  const search = useSearch();
  const [, setLocation] = useLocation();
  const trpc = useTRPC();
  const api = useTRPCClient();
  const queryClient = useQueryClient();
  const toast = useToast();

  const taskKey = useMemo(() => {
    const raw = new URLSearchParams(search).get("taskKey")?.trim() ?? "";
    return TASK_KEY_RE.test(raw) ? raw : undefined;
  }, [search]);

  const validIds = ULID_RE.test(orderId) && ULID_RE.test(fileId);
  const ordersIndexHref = area === "console" ? "/admin/orders" : "/orders";
  const orderHref = area === "console" ? `/admin/orders/${orderId}` : `/orders/${orderId}`;
  const orderFilesHref = `${orderHref}/files`;

  const queryInput = useMemo(
    () => ({
      orderPublicId: orderId,
      filePublicId: fileId,
      ...(taskKey ? { taskKey } : {}),
    }),
    [orderId, fileId, taskKey],
  );

  const statusQuery = useQuery(
    trpc.files.document.status.queryOptions(queryInput, {
      enabled: validIds,
      retry: false,
    }),
  );

  const versionsQuery = useQuery(
    trpc.files.document.versions.queryOptions(queryInput, {
      enabled: validIds,
      retry: false,
    }),
  );

  const status = statusQuery.data;
  const maxBytes = status?.maxBytes;
  const statusFileId = status?.file.publicId;
  const docKey = `${orderId}:${fileId}:${taskKey ?? ""}:${statusFileId ?? ""}`;

  const docContentQuery = useQuery({
    queryKey: ["docedit.content", orderId, fileId, taskKey ?? null, statusFileId ?? null, maxBytes ?? 0],
    enabled: validIds && Boolean(statusFileId) && Boolean(maxBytes),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    queryFn: async ({ signal }): Promise<LoadedDocumentState> => {
      const endpoint = apiUrl(buildDocumentEndpoint(orderId, fileId, taskKey));
      const response = await sessionFetch(endpoint, {
        method: "GET",
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        const message = await readHttpErrorMessage(
          response,
          "The Word document could not be loaded from this order.",
        );
        throw new Error(message);
      }
      const bytes = await response.arrayBuffer();
      const converted = await docxToHtml(bytes, { maxBytes });
      return {
        filePublicId: statusFileId!,
        baselineHtml: converted.sanitizedHtml,
        warnings: converted.warnings,
        detectedUnsupported: converted.detectedUnsupported,
      };
    },
  });

  const [draftState, setDraftState] = useState<{
    readonly docKey: string;
    readonly baselineOverride?: string;
    readonly html: string;
  } | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const [saveErrorState, setSaveErrorState] = useState<{
    readonly docKey: string;
    readonly message: string;
  } | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [pendingLeave, setPendingLeave] = useState<PendingLeaveAction | null>(null);

  const loadedDoc = docContentQuery.data ?? null;
  const docLoading = Boolean(statusFileId) && docContentQuery.isPending;
  const docLoadError = docContentQuery.error
    ? docContentQuery.error instanceof DocConvertError
      ? docContentQuery.error.safeMessage
      : errorMessage(
          docContentQuery.error,
          "This Word document could not be converted for portal editing.",
        )
    : null;

  const activeDraft = draftState?.docKey === docKey ? draftState : null;
  const baselineHtml = activeDraft?.baselineOverride ?? loadedDoc?.baselineHtml ?? "";
  const draftHtml = activeDraft ? activeDraft.html : baselineHtml;
  const saveError = saveErrorState?.docKey === docKey ? saveErrorState.message : null;

  const setDraftHtml = (nextHtml: string) => {
    setDraftState((prev) => ({
      docKey,
      baselineOverride: prev?.docKey === docKey ? prev.baselineOverride : undefined,
      html: nextHtml,
    }));
  };

  const canEditNow = status?.enabled === true && status?.canEdit === true && loadedDoc !== null;
  const isDirty =
    canEditNow && loadedDoc.filePublicId === fileId && draftHtml !== baselineHtml;

  useEffect(() => {
    if (!isDirty || saving) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [isDirty, saving]);

  const requestNavigate = (href: string) => {
    if (isDirty) {
      setPendingLeave({ kind: "navigate", href });
      return;
    }
    setLocation(href);
  };

  const requestDiscard = () => {
    if (!isDirty || !loadedDoc) return;
    setPendingLeave({ kind: "discard" });
  };

  const confirmLeaveOrDiscard = () => {
    if (!pendingLeave) return;
    const action = pendingLeave;
    setPendingLeave(null);
    if (action.kind === "discard") {
      if (loadedDoc) {
        setDraftState((prev) => ({
          docKey,
          baselineOverride: prev?.docKey === docKey ? prev.baselineOverride : undefined,
          html: baselineHtml,
        }));
        setSaveErrorState(null);
      }
      return;
    }
    setDraftState(null);
    setLocation(action.href);
  };

  const downloadVersion = async (file: FileRecord) => {
    if (downloadingId) return;
    setDownloadingId(file.publicId);
    try {
      const { ticket } = await api.files.issueDownloadTicket.mutate({ fileId: file.publicId });
      const response = await sessionFetch(apiUrl("/api/files/download"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket }),
        cache: "no-store",
      });
      if (
        !response.ok ||
        !/^attachment[;\s]/iu.test(response.headers.get("content-disposition") ?? "")
      ) {
        toast.show({
          title: "Download not available",
          description: "The download could not be authorized. Refresh this page and try again.",
          tone: "danger",
        });
        return;
      }
      const blob = await response.blob();
      if (blob.size !== file.size) {
        toast.show({
          title: "Incomplete download",
          description: "The server did not return the expected file size.",
          tone: "danger",
        });
        return;
      }
      const href = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.download = file.displayName;
        document.body.append(anchor);
        try {
          anchor.click();
        } finally {
          anchor.remove();
        }
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(href), 30_000);
      }
    } catch (err) {
      toast.show({
        title: "Download not available",
        description: errorMessage(err, "The file could not be downloaded."),
        tone: "danger",
      });
    } finally {
      setDownloadingId(null);
    }
  };

  const saveAsNewVersion = async () => {
    if (!status || !loadedDoc || !canEditNow || !isDirty || saving) return;
    setSaving(true);
    setSaveErrorState(null);
    try {
      const built = await editorToDocx(draftHtml, {
        maxBytes: status.maxBytes,
      });
      const fileName = ensureDocxFileName(status.file.displayName);
      const formData = new FormData();
      const uploadBytes = new Uint8Array(built.bytes.byteLength);
      uploadBytes.set(built.bytes);
      formData.append("files", new File([uploadBytes], fileName, { type: DOCX_MIME }));

      const endpoint = apiUrl(buildDocumentEndpoint(orderId, fileId, taskKey));
      const response = await sessionFetch(endpoint, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const message = await readHttpErrorMessage(
          response,
          "The edited Word document could not be saved as a new version.",
        );
        setSaveErrorState({ docKey, message });
        if (response.status === 409 || response.status === 403) {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: trpc.files.document.status.pathKey() }),
            queryClient.invalidateQueries({ queryKey: trpc.files.document.versions.pathKey() }),
          ]);
        }
        return;
      }

      const saved = (await response.json()) as FileRecord;
      setDraftState({
        docKey,
        baselineOverride: draftHtml,
        html: draftHtml,
      });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.files.pathKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.orders.pathKey() }),
      ]);

      toast.show({
        title: `Saved as version v${saved.version}`,
        description: taskKey
          ? "Your completed document response was saved to the order."
          : "A new Word version was saved while keeping earlier versions intact.",
        tone: "success",
      });

      if (saved.publicId && saved.publicId !== fileId) {
        setLocation(orderDocumentEditHref(orderId, saved.publicId, { area }));
      }
    } catch (err) {
      const message =
        err instanceof DocConvertError
          ? err.safeMessage
          : errorMessage(err, "The edited Word document could not be saved.");
      setSaveErrorState({ docKey, message });
    } finally {
      setSaving(false);
    }
  };

  const versions = useMemo(() => {
    const items = versionsQuery.data ?? [];
    return [...items].sort((a, b) => b.version - a.version);
  }, [versionsQuery.data]);

  const versionById = useMemo(() => {
    const map = new Map<string, FileRecord>();
    for (const item of versions) map.set(item.publicId, item);
    return map;
  }, [versions]);

  const latestActiveVersion = useMemo(
    () => versions.find((v) => v.supersededAt === null && v.publicId !== fileId) ?? null,
    [versions, fileId],
  );

  if (!validIds) {
    return (
      <EmptyState
        variant="error"
        title="Document link not valid"
        description="Check the order link and select Open in editor from the order's Files tab or task list."
        action={<Button onClick={() => setLocation(ordersIndexHref)}>Back to orders</Button>}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: "Orders", href: ordersIndexHref },
              { label: "Order", href: orderHref },
              { label: "Files", href: orderFilesHref },
              { label: status?.file.displayName ?? "Word document" },
            ]}
          />
        }
        title={status?.file.displayName ?? "Word document"}
        meta={
          status ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">v{status.file.version}</Badge>
              {taskKey ? <Badge tone="info">Document response task</Badge> : null}
              {isDirty ? <Badge tone="warning">Unsaved changes</Badge> : null}
              {!status.canEdit ? <Badge tone="neutral">Read-only</Badge> : null}
            </div>
          ) : undefined
        }
        description={
          taskKey
            ? "Review and edit this Word document in your browser, then save your completed response to the order."
            : "Edit supported Word formatting in your browser and save changes as a new version without overwriting the original upload."
        }
        actions={
          <>
            <Button
              variant="secondary"
              leadingIcon={<ArrowLeft aria-hidden="true" />}
              onClick={() => requestNavigate(taskKey ? orderHref : orderFilesHref)}
            >
              {taskKey ? "Back to order" : "Back to files"}
            </Button>
            {status ? (
              <Button
                variant="secondary"
                leadingIcon={<Download aria-hidden="true" />}
                loading={downloadingId === status.file.publicId}
                onClick={() => {
                  void downloadVersion(status.file);
                }}
              >
                Download .docx
              </Button>
            ) : null}
            {canEditNow ? (
              <>
                <Button
                  variant="ghost"
                  leadingIcon={<RotateCcw aria-hidden="true" />}
                  disabled={!isDirty || saving}
                  onClick={requestDiscard}
                >
                  Discard changes
                </Button>
                <Button
                  leadingIcon={<Save aria-hidden="true" />}
                  loading={saving}
                  disabled={!isDirty}
                  onClick={() => {
                    void saveAsNewVersion();
                  }}
                >
                  Save as new version
                </Button>
              </>
            ) : null}
          </>
        }
      />

      {statusQuery.isPending ? (
        <Card>
          <div className="flex items-center gap-3 py-6 text-sm text-body" role="status">
            <Spinner />
            <span>Checking document permissions and version status...</span>
          </div>
        </Card>
      ) : null}

      {statusQuery.error ? (
        <Callout
          tone="danger"
          live="assertive"
          title="Document unavailable"
          actions={
            <Button variant="secondary" onClick={() => setLocation(orderHref)}>
              Return to order
            </Button>
          }
        >
          {errorMessage(statusQuery.error, "This Word document could not be opened.")}
        </Callout>
      ) : null}

      {status ? (
        <>
          <Callout
            tone={loadedDoc && loadedDoc.detectedUnsupported.length > 0 ? "warning" : "info"}
            title="Portal Word editing limits"
          >
            <p>
              Your original <span className="font-medium">.docx</span> file remains intact in version
              history and can be downloaded at any time. Saving creates a new{" "}
              <span className="font-medium">.docx</span> version (up to{" "}
              {formatFileBytes(status.maxBytes)}) and does not store drafts in your browser. Running
              headers and footers, tracked changes, margin comments, floating text boxes or shapes,
              footnotes/endnotes, dynamic Word fields, and exact desktop fonts or page pagination are
              not preserved when saving from the portal.
            </p>
            {loadedDoc && loadedDoc.detectedUnsupported.length > 0 ? (
              <div className="mt-2">
                <p className="font-semibold text-ink">
                  Detected in this document (not preserved if you save a portal-edited version):
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {loadedDoc.detectedUnsupported.map((feature) => (
                    <li key={feature.key}>
                      <span className="font-medium text-ink">{feature.label}:</span>{" "}
                      {feature.detail}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {loadedDoc && loadedDoc.warnings.length > 0 ? (
              <div className="mt-2">
                <p className="font-semibold text-ink">Conversion notes:</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {loadedDoc.warnings.map((warning, idx) => (
                    <li key={`${idx}-${warning}`}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Callout>

          {!status.canEdit ? (
            <Callout
              tone="warning"
              live="polite"
              title={
                status.agreementPolicyPublicId
                  ? "Order agreement required before saving"
                  : "Editing is disabled for this version"
              }
              actions={
                <>
                  {status.agreementPolicyPublicId ? (
                    <Button size="sm" onClick={() => requestNavigate(orderHref)}>
                      Review and sign order agreement
                    </Button>
                  ) : null}
                  {latestActiveVersion ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        requestNavigate(
                          orderDocumentEditHref(orderId, latestActiveVersion.publicId, { area }),
                        )
                      }
                    >
                      Open latest version (v{latestActiveVersion.version})
                    </Button>
                  ) : null}
                </>
              }
            >
              {status.disabledReason ??
                "Portal Word editing is currently read-only for this document. You can still inspect its contents below or download the original .docx."}
            </Callout>
          ) : null}

          {saveError ? (
            <Callout tone="danger" live="assertive" title="Could not save new version">
              {saveError}
            </Callout>
          ) : null}

          {docLoading ? (
            <Card>
              <div className="flex items-center gap-3 py-8 text-sm text-body" role="status">
                <Spinner />
                <span>Converting Word document securely in your browser...</span>
              </div>
            </Card>
          ) : null}

          {docLoadError ? (
            <Callout
              tone="danger"
              live="assertive"
              title="Browser conversion stopped"
              actions={
                <Button
                  size="sm"
                  variant="secondary"
                  leadingIcon={<Download aria-hidden="true" />}
                  loading={downloadingId === status.file.publicId}
                  onClick={() => {
                    void downloadVersion(status.file);
                  }}
                >
                  Download original .docx
                </Button>
              }
            >
              {docLoadError}
            </Callout>
          ) : null}

          {loadedDoc && !docLoading ? (
            <Card
              title="Document content"
              description={
                canEditNow
                  ? "Supports headings, bold, italic, underline, strikethrough, alignment, lists, links, and tables. Unsaved edits live only in memory on this tab."
                  : "Read-only preview of the converted Word document."
              }
            >
              <Suspense
                fallback={
                  <div className="flex items-center gap-3 py-8 text-sm text-body" role="status">
                    <Spinner />
                    <span>Loading document editor...</span>
                  </div>
                }
              >
                <DocumentEditorCanvas
                  label={status.file.displayName}
                  value={draftHtml}
                  onChange={setDraftHtml}
                  readOnly={!canEditNow || saving}
                  hint={
                    canEditNow
                      ? isDirty
                        ? "Unsaved edits in memory"
                        : "All changes saved"
                      : "Read-only"
                  }
                />
              </Suspense>
            </Card>
          ) : null}

          <Section
            title="Version history"
            description="Every portal save creates a new .docx version and records which earlier file it was derived from."
          >
            <Card>
              {versionsQuery.isPending ? (
                <div className="flex items-center gap-3 py-4 text-sm text-body" role="status">
                  <Spinner size="sm" />
                  <span>Loading document versions...</span>
                </div>
              ) : versions.length === 0 ? (
                <p className="text-sm text-muted">No versions recorded yet.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {versions.map((item) => {
                    const isViewing = item.publicId === fileId;
                    const derivedId = item.derivedFromPublicId ?? item.derivedFromFileId ?? null;
                    const parent = derivedId ? versionById.get(derivedId) : undefined;
                    const isCurrent = item.supersededAt === null;
                    return (
                      <li
                        key={item.publicId}
                        className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <FileSpreadsheet
                              aria-hidden="true"
                              className="size-4 shrink-0 text-muted"
                            />
                            <span className="font-medium text-ink break-words">
                              {item.displayName}
                            </span>
                            <Badge tone="neutral">v{item.version}</Badge>
                            {isCurrent ? (
                              <Badge tone="success">Current</Badge>
                            ) : (
                              <Badge tone="neutral">Superseded</Badge>
                            )}
                            {isViewing ? <Badge tone="info">Viewing</Badge> : null}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                            <span>{formatFileBytes(item.size)}</span>
                            <span>
                              Uploaded <DateTime value={item.createdAt} />
                            </span>
                            {parent ? (
                              <span className="inline-flex items-center gap-1">
                                <History aria-hidden="true" className="size-3.5" />
                                Edited from v{parent.version}
                              </span>
                            ) : derivedId ? (
                              <span className="inline-flex items-center gap-1">
                                <History aria-hidden="true" className="size-3.5" />
                                Edited in portal
                              </span>
                            ) : null}
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          {!isViewing && isCurrent ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                requestNavigate(
                                  orderDocumentEditHref(orderId, item.publicId, { area }),
                                )
                              }
                            >
                              Open in editor
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            leadingIcon={<Download aria-hidden="true" />}
                            loading={downloadingId === item.publicId}
                            onClick={() => {
                              void downloadVersion(item);
                            }}
                          >
                            Download
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </Section>
        </>
      ) : null}

      <ConfirmDialog
        open={pendingLeave !== null}
        onOpenChange={(open) => {
          if (!open) setPendingLeave(null);
        }}
        title={
          pendingLeave?.kind === "discard"
            ? "Discard unsaved document changes?"
            : "Leave with unsaved document changes?"
        }
        description="Unsaved edits are kept only in memory on this page and will be lost if you continue."
        confirmLabel={pendingLeave?.kind === "discard" ? "Discard changes" : "Leave without saving"}
        cancelLabel="Keep editing"
        destructive
        onConfirm={confirmLeaveOrDiscard}
      />
    </div>
  );
}
