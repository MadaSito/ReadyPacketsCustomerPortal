/**
 * D8 ZIP download buttons. PhaseArchiveAction: anyone who may see the phase's files. OrderArchiveAction: administrators
 * only (server enforces files.archive.order + fresh step-up; the step-up dialog is shown when the server asks).
 * Flow: request → poll status (polite live region) → single-use ticket → POST /api/files/archives/download.
 * The ZIP is fetched as a Blob (same pattern as single-file downloads); archives are capped at 500 MiB server-side.
 */
import { useEffect, useRef, useState } from "react";
import { Archive } from "lucide-react";
import { apiUrl } from "@/lib/runtime";
import { sessionFetch } from "@/lib/sessionTransport";
import { errorMessage, useTRPCClient } from "@/lib/trpc";
import { Button, StepUpCancelledError, useStepUp } from "@/ui";
import { formatBytes } from "../format";
import { saveFileBlob } from "../fileDownload";

type Phase = "idle" | "preparing" | "downloading" | "done" | "error";
const POLL_MS = 2_000;
const MAX_POLLS = 300;

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
        if (i >= MAX_POLLS || !alive.current) throw new Error("The archive is taking too long. Try again later.");
        await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
        view = await api.fileArchives.status.query({ archiveId: view.archiveId });
      }
      if (view.state !== "ready") throw new Error(view.reasonCode === "ARCHIVE_STALE"
        ? "The files changed while the archive was being prepared. Try again."
        : "The archive could not be prepared. Try again or download files individually.");
      if (!alive.current) return;
      setPhase("downloading");
      setMessage(`Downloading ${view.fileCount} files (${formatBytes(view.zipBytes ?? view.totalBytes)})…`);
      const issue = () => api.fileArchives.issueDownloadTicket.mutate({ archiveId: view.archiveId });
      const { ticket } = stageKey ? await issue() : await stepUp.run(issue, { reason: "Downloading every file of an order requires a fresh identity check." });
      const response = await sessionFetch(apiUrl("/api/files/archives/download"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket }), cache: "no-store",
      });
      if (!response.ok || !/^attachment[;\s]/iu.test(response.headers.get("content-disposition") ?? "")) {
        throw new Error("The download could not be authorized or completed. Prepare the archive again.");
      }
      const blob = await response.blob();
      if (view.zipBytes !== null && blob.size !== view.zipBytes) throw new Error("The download was incomplete. Prepare the archive again.");
      saveFileBlob(blob, filename);
      setPhase("done");
      setMessage("The ZIP archive was downloaded.");
    } catch (cause) {
      if (cause instanceof StepUpCancelledError) { setPhase("idle"); setMessage("Download canceled."); return; }
      setPhase("error");
      setMessage(errorMessage(cause, "The archive could not be downloaded."));
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
