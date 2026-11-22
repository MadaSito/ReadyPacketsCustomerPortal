/**
 * Private Knowledge Base attachment download & multipart upload helpers.
 * Uses `sessionFetch` so CSRF/origin and session headers follow the portal transport contract.
 */
import type { KnowledgeAttachmentView } from "@server/modules/knowledge/types";
import { apiUrl } from "@/lib/runtime";
import { sessionFetch } from "@/lib/sessionTransport";

export interface KnowledgeUploadResultItem {
  index: number;
  outcome: "completed" | "refused" | "unknown";
  attachment?: KnowledgeAttachmentView;
  reason?: string;
  message?: string;
}

export async function redeemKnowledgeAttachmentDownload(
  issueTicket: (attachmentPublicId: string) => Promise<{ ticket: string }>,
  attachment: Pick<KnowledgeAttachmentView, "publicId" | "displayName" | "size">,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { ticket } = await issueTicket(attachment.publicId);
  const response = await sessionFetch(apiUrl("/api/knowledge/attachments/download"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket }),
    cache: "no-store",
  });
  if (
    !response.ok ||
    !/^attachment[;\s]/iu.test(response.headers.get("content-disposition") ?? "")
  ) {
    return {
      ok: false,
      message: "The download could not be authorized or completed. Refresh the page and try again.",
    };
  }
  const blob = await response.blob();
  if (blob.size !== attachment.size) {
    return {
      ok: false,
      message: "The server did not return the expected file size.",
    };
  }
  const href = URL.createObjectURL(blob);
  try {
    const trigger = document.createElement("a");
    trigger.href = href;
    trigger.download = attachment.displayName;
    document.body.append(trigger);
    try {
      trigger.click();
    } finally {
      trigger.remove();
    }
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(href), 30_000);
  }
  return { ok: true };
}

export async function uploadKnowledgeAttachments(
  articlePublicId: string,
  files: readonly File[],
): Promise<KnowledgeUploadResultItem[]> {
  const form = new FormData();
  for (const file of files) {
    form.append("files", file, file.name);
  }
  const response = await sessionFetch(
    apiUrl(`/api/knowledge/attachments/${encodeURIComponent(articlePublicId)}`),
    {
      method: "POST",
      body: form,
      cache: "no-store",
    },
  );
  if (!response.ok) {
    throw new Error("Upload request was refused.");
  }
  const payload = (await response.json()) as { results?: KnowledgeUploadResultItem[] };
  return payload.results ?? [];
}
