import { apiUrl } from "@/lib/runtime";
import { sessionFetch } from "@/lib/sessionTransport";

class TransferHttpError extends Error {
  constructor(readonly data: { safe?: { domainCode?: string; safeMessage?: string } }) {
    super("Transfer request did not complete.");
  }
}

async function request(path: string, options?: RequestInit) {
  const response = await sessionFetch(apiUrl(`/api/portable/${path}`), { cache: "no-store", ...options });
  if (!response.ok) {
    const data = await response.json().catch(() => undefined) as ConstructorParameters<typeof TransferHttpError>[0] | undefined;
    throw new TransferHttpError(data ?? {});
  }
  return response;
}

export async function uploadPackage(file: File) {
  const response = await request("imports", {
    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file,
  });
  const payload = await response.json() as { importId?: unknown };
  if (typeof payload.importId !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(payload.importId)) {
    throw new Error("The upload receipt could not be read.");
  }
  return payload.importId;
}

export async function downloadPackage(exportId: string): Promise<void> {
  const response = await request(`exports/${encodeURIComponent(exportId)}/download`);
  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = `readypackets-transfer-${exportId}.rpkg`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}
