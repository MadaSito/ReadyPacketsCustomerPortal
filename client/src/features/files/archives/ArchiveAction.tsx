/**
 * D8 ZIP download buttons. PhaseArchiveAction: anyone who may see the phase's files. OrderArchiveAction: administrators
 * only (server enforces files.archive.order + fresh step-up; the step-up dialog is shown when the server asks).
 * Flow: request → poll status (polite live region) → single-use ticket → native form POST to
 * /api/files/archives/download (ticket + CSRF token as hidden fields). The browser streams the attachment to disk;
 * the ZIP is never held in page memory. A refused form POST answers 204, so the page stays put; the client then
 * reads the archive's download count to tell the user whether the download started. The sandboxed preview build
 * (no cookies, form path refused) falls back to a fetch.
 */
import { useEffect, useRef, useState } from "react";
import { Archive } from "lucide-react";
import { apiUrl, RUNTIME } from "@/lib/runtime";
import { csrfToken, sessionFetch } from "@/lib/sessionTransport";
import { errorMessage, useTRPCClient } from "@/lib/trpc";
import { Button, StepUpCancelledError, useStepUp } from "@/ui";
import { formatBytes } from "../format";
import { saveFileBlob } from "../fileDownload";

type Phase = "idle" | "preparing" | "downloading" | "done" | "error";
const POLL_MS = 2_000;
const MAX_POLLS = 300;
const CONFIRM_POLLS = 10;
const CONFIRM_MS = 1_000;
const DOWNLOAD_PATH = "/api/files/archives/download";

/** A user-facing, already-safe message from this flow (server errors go through errorMessage). */
class ArchiveError extends Error {}

/** Submits a native top-level form POST so the browser streams the attachment to disk. */
export function submitDownloadForm(ticket: string, csrf: string): void {
  const form = document.createElement("form");
  form.method = "post";
  form.action = apiUrl(DOWNLOAD_PATH);
  form.enctype = "application/x-www-form-urlencoded";
  form.hidden = true;
  for (const [name, value] of [["ticket", ticket], ["csrf", csrf]] as const) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  try { form.submit(); } finally { form.remove(); }
}

function useArchive(orderId: string, stageKey: string | null, filename: string) {
  const api = useTRPCClient();
  const stepUp = useStepUp();
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  async function run() {
    if (phase === "preparing" || phase === "downloading") return;
    setPhase("preparing");
    setMessage("Preparing the ZIP archive…");
    try {
      const request = () => api.fileArchives.request.mutate({ orderId, stageKey });
      let view = stageKey ? await request() : await stepUp.run(request, { reason: "Downloading every file of an order requires a fresh identity check." });
      for (let i = 0; view.state === "queued" || view.state === "building"; i += 1) {
        if (i >= MAX_POLLS || !alive.current) throw new ArchiveError("The archive is taking too long. Try again later.");
        await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
        view = await api.fileArchives.status.query({ archiveId: view.archiveId });
      }
      if (view.state !== "ready") throw new ArchiveError(view.reasonCode === "ARCHIVE_STALE"
        ? "The files changed while the archive was being prepared. Try again."
        : "The archive could not be prepared. Try again or download files individually.");
      if (!alive.current) return;
      setPhase("downloading");
      setMessage(`Downloading ${view.fileCount} files (${formatBytes(view.zipBytes ?? view.totalBytes)})…`);
      const issue = () => api.fileArchives.issueDownloadTicket.mutate({ archiveId: view.archiveId });
      const { ticket } = stageKey ? await issue() : await stepUp.run(issue, { reason: "Downloading every file of an order requires a fresh identity check." });
      if (RUNTIME.preview) {
        const response = await sessionFetch(apiUrl(DOWNLOAD_PATH), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket }), cache: "no-store",
        });
        if (!response.ok || !/^attachment[;\s]/iu.test(response.headers.get("content-disposition") ?? "")) {
          throw new ArchiveError("The download could not be authorized or completed. Prepare the archive again.");
        }
        saveFileBlob(await response.blob(), filename);
        setPhase("done");
        setMessage("The ZIP archive was downloaded.");
        return;
      }
      const csrf = csrfToken();
      if (!csrf) throw new ArchiveError("Your session needs a refresh. Reload the page and try again.");
      const before = view.downloadCount;
      submitDownloadForm(ticket, csrf);
      for (let i = 0; i < CONFIRM_POLLS && alive.current; i += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, CONFIRM_MS));
        const now = await api.fileArchives.status.query({ archiveId: view.archiveId });
        if (now.downloadCount > before) {
          setPhase("done");
          setMessage("Your browser is saving the ZIP archive. Check your downloads.");
          return;
        }
        if (now.state !== "ready") throw new ArchiveError(now.reasonCode === "ARCHIVE_STALE"
          ? "The files changed since this archive was prepared. Prepare it again."
          : "The archive is no longer available. Prepare it again.");
      }
      if (alive.current) throw new ArchiveError("The download did not start. Prepare the archive again.");
    } catch (cause) {
      if (cause instanceof StepUpCancelledError) { setPhase("idle"); setMessage("Download canceled."); return; }
      setPhase("error");
      setMessage(cause instanceof ArchiveError ? cause.message : errorMessage(cause, "The archive could not be downloaded."));
    }
  }
  return { phase, message, run };
}

function ArchiveButton({ label, orderId, stageKey, filename }: { label: string; orderId: string; stageKey: string | null; filename: string }) {
  const { phase, message, run } = useArchive(orderId, stageKey, filename);
  const busy = phase === "preparing" || phase === "downloading";
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <Button variant="secondary" size="sm" leadingIcon={<Archive aria-hidden="true" />} loading={busy} onClick={() => void run()}>
        {label}
      </Button>
      <p role="status" aria-live="polite" className={phase === "error" ? "text-sm text-danger" : "text-sm text-muted"}>{message}</p>
    </div>
  );
}

/** Phase ZIP: every current deliverable of one phase that the viewer may see. */
export function PhaseArchiveAction({ orderId, stageKey, phaseName }: { orderId: string; stageKey: string; phaseName?: string }) {
  return <ArchiveButton label={phaseName ? `Download ${phaseName} files (ZIP)` : "Download phase files (ZIP)"} orderId={orderId} stageKey={stageKey} filename={`order-${orderId}-phase-${stageKey}.zip`} />;
}

/** Whole-order ZIP (administrators; the server requires a fresh identity check). Render only for administrators. */
export function OrderArchiveAction({ orderId }: { orderId: string }) {
  return <ArchiveButton label="Download all files (ZIP)" orderId={orderId} stageKey={null} filename={`order-${orderId}-all-files.zip`} />;
}
