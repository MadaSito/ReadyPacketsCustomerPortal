/**
 * Browser-only `.docx` -> sanitised HTML + Markdown + plainText converter via Mammoth (Increment 06 D9 & D12).
 * Enforces 10 MB byte guard, ZIP Central-Directory <-> Local-Header coherence, actual bounded stream inflation,
 * OOXML unsupported-feature detection, terminable same-origin Worker execution (failing closed if Worker
 * isolation is unavailable rather than running non-terminable Mammoth on the UI thread), and HTML sanitisation.
 */
import { DocConvertError, type DocConvertOptions, type DocxToHtmlResult } from "./types";
import type { DocxWorkerRequest, DocxWorkerResponse } from "./docxWorker";
import {
  detectDocxUnsupportedFeaturesFromXml,
  inspectZipArchive,
  toOwnedArrayBuffer,
  toUint8Array,
  verifyZipActualInflation,
  withConversionTimeout,
} from "./guards";
import { htmlToMarkdown } from "./markdown";
import { htmlToPlainText, sanitizeDocumentHtmlWithWarnings } from "./sanitize";

const MAMMOTH_STYLE_MAP = [
  "b => strong",
  "i => em",
  "u => u",
  "strike => s",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
];

let nextRequestId = 1;

async function convertViaTerminableWorker(
  arrayBuffer: ArrayBuffer,
  signal: AbortSignal,
): Promise<{ rawHtml: string; messages: Array<{ type: string; message: string }> }> {
  if (typeof Worker === "undefined") {
    throw new DocConvertError(
      "WORKER_UNAVAILABLE",
      "Browser worker isolation is required to open Word documents safely and is unavailable in this environment.",
    );
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL("./docxWorker.ts", import.meta.url), { type: "module" });
  } catch {
    throw new DocConvertError(
      "WORKER_UNAVAILABLE",
      "Unable to start an isolated browser worker to open this Word document safely.",
    );
  }

  const requestId = nextRequestId++;

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      try {
        worker.terminate();
      } catch {
        // ignore termination errors
      }
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new DocConvertError(
          "CONVERSION_TIMEOUT",
          "Converting this document took too long and was stopped.",
        ),
      );
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    worker.onmessage = (event: MessageEvent<DocxWorkerResponse>) => {
      const msg = event.data;
      if (!msg || msg.id !== requestId || settled) return;
      settled = true;
      cleanup();
      if (msg.ok) {
        resolve({ rawHtml: msg.rawHtml, messages: msg.messages });
      } else {
        reject(new DocConvertError("DOCX_PARSE_FAILED", msg.errorMessage));
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new DocConvertError(
          "DOCX_PARSE_FAILED",
          event.message || "Unable to read this Word (.docx) document.",
        ),
      );
    };

    const payload: DocxWorkerRequest = {
      id: requestId,
      arrayBuffer,
      styleMap: MAMMOTH_STYLE_MAP,
    };
    worker.postMessage(payload, [arrayBuffer]);
  });
}

export async function docxToHtml(
  input: ArrayBuffer | Uint8Array | Blob,
  options?: DocConvertOptions,
): Promise<DocxToHtmlResult> {
  const bytes = await toUint8Array(input, options?.maxBytes);
  const inspection = inspectZipArchive(bytes);

  return withConversionTimeout(async (signal) => {
    const { documentXml } = await verifyZipActualInflation(bytes, inspection, undefined, signal);
    const detectedUnsupported = detectDocxUnsupportedFeaturesFromXml(inspection, documentXml);

    let rawHtml: string;
    let mammothMessages: Array<{ type: string; message: string }>;
    try {
      const converted = await convertViaTerminableWorker(toOwnedArrayBuffer(bytes), signal);
      rawHtml = converted.rawHtml;
      mammothMessages = converted.messages;
    } catch (err) {
      if (err instanceof DocConvertError) throw err;
      throw new DocConvertError(
        "DOCX_PARSE_FAILED",
        "This Word (.docx) document could not be parsed. Download the original file to view it in Word.",
      );
    }

    const sanitized = sanitizeDocumentHtmlWithWarnings(rawHtml);
    const warnings = new Set<string>();

    for (const item of detectedUnsupported) {
      warnings.add(`${item.label}: ${item.detail}`);
    }
    for (const msg of mammothMessages) {
      if (msg.type === "warning" && msg.message.trim()) {
        const cleaned = msg.message.trim();
        if (!cleaned.toLowerCase().startsWith("unrecognised paragraph style")) {
          warnings.add(cleaned);
        }
      }
    }
    for (const w of sanitized.warnings) {
      warnings.add(w);
    }

    const sanitizedHtml = sanitized.html;
    const plainText = htmlToPlainText(sanitizedHtml);
    const markdown = htmlToMarkdown(sanitizedHtml);

    return {
      sanitizedHtml,
      markdown,
      plainText,
      warnings: Array.from(warnings),
      detectedUnsupported,
    };
  }, options?.timeoutMs);
}
