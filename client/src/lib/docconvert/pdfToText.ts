/**
 * Browser-only PDF text extraction via `pdfjs-dist` legacy ES bundle (Increment 06 D9 & D12).
 * Uses a same-origin bundled worker asset (`?url`), explicitly disables `eval`, WebAssembly, font faces,
 * worker fetch, and XFA so strict CSP (`script-src 'self' 'nonce-...'`, `style-src 'self'`, `worker-src 'self'`)
 * holds without `unsafe-eval` or `wasm-unsafe-eval`. Enforces 10 MB, clamped 200-page ceiling, cumulative
 * 2,000,000-character extracted-text cap, and wall-clock timeout.
 */
import {
  DocConvertError,
  MAX_PDF_EXTRACTED_CHARS,
  MAX_PDF_PAGES,
  type PdfToTextOptions,
  type PdfToTextResult,
} from "./types";
import { assertPdfHeader, toUint8Array, withConversionTimeout } from "./guards";
import { htmlToMarkdown } from "./markdown";
import { sanitizeDocumentHtml } from "./sanitize";

export type PdfConvertOptions = PdfToTextOptions;

function effectiveMaxPages(maxPages?: number): number {
  if (maxPages === undefined || !Number.isFinite(maxPages) || maxPages <= 0) {
    return MAX_PDF_PAGES;
  }
  return Math.min(Math.floor(maxPages), MAX_PDF_PAGES);
}

function effectiveMaxExtractedChars(maxExtractedChars?: number): number {
  if (
    maxExtractedChars === undefined ||
    !Number.isFinite(maxExtractedChars) ||
    maxExtractedChars <= 0
  ) {
    return MAX_PDF_EXTRACTED_CHARS;
  }
  return Math.min(Math.floor(maxExtractedChars), MAX_PDF_EXTRACTED_CHARS);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function reconstructPageText(items: ReadonlyArray<unknown>): string {
  const lines: string[] = [];
  let currentLine = "";

  for (const raw of items) {
    if (!raw || typeof raw !== "object" || !("str" in raw)) continue;
    const item = raw as { str?: unknown; hasEOL?: unknown };
    const text = typeof item.str === "string" ? item.str : "";
    const hasEOL = item.hasEOL === true;

    if (text) {
      if (
        currentLine.length > 0 &&
        !currentLine.endsWith(" ") &&
        !currentLine.endsWith("-") &&
        !text.startsWith(" ") &&
        !/^[.,;:!?)\]]/.test(text)
      ) {
        currentLine += " ";
      }
      currentLine += text;
    }

    if (hasEOL) {
      const trimmed = currentLine.replace(/[ \t]+/g, " ").trim();
      lines.push(trimmed);
      currentLine = "";
    }
  }

  if (currentLine.trim()) {
    lines.push(currentLine.replace(/[ \t]+/g, " ").trim());
  }

  const paragraphs: string[] = [];
  let buffer: string[] = [];
  for (const line of lines) {
    if (!line) {
      if (buffer.length > 0) {
        paragraphs.push(buffer.join("\n"));
        buffer = [];
      }
    } else {
      buffer.push(line);
    }
  }
  if (buffer.length > 0) {
    paragraphs.push(buffer.join("\n"));
  }
  return paragraphs.join("\n\n").trim();
}

export async function pdfToText(
  input: ArrayBuffer | Uint8Array | Blob,
  options?: PdfConvertOptions,
): Promise<PdfToTextResult> {
  const bytes = await toUint8Array(input, options?.maxBytes);
  assertPdfHeader(bytes);
  const maxPages = effectiveMaxPages(options?.maxPages);
  const maxChars = effectiveMaxExtractedChars(options?.maxExtractedChars);

  let activeDestroy: (() => void) | undefined;

  return withConversionTimeout(
    async (signal) => {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        const workerAsset = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url");
        pdfjs.GlobalWorkerOptions.workerSrc = workerAsset.default;
      }

      const loadingTask = pdfjs.getDocument({
        data: bytes.slice(),
        useWasm: false,
        useWorkerFetch: false,
        useSystemFonts: false,
        disableFontFace: true,
        isOffscreenCanvasSupported: false,
        isImageDecoderSupported: false,
        enableXfa: false,
        ...({ isEvalSupported: false } as Record<string, unknown>),
      });

      activeDestroy = () => {
        void loadingTask.destroy();
      };

      try {
        let pdfDoc: Awaited<typeof loadingTask.promise>;
        try {
          pdfDoc = await loadingTask.promise;
        } catch (err) {
          if (signal.aborted) {
            throw new DocConvertError(
              "CONVERSION_TIMEOUT",
              "Extracting text from this PDF took too long and was stopped.",
            );
          }
          throw new DocConvertError(
            "PDF_PARSE_FAILED",
            err instanceof Error && /password/i.test(err.message)
              ? "Password-protected PDFs cannot be imported in the browser."
              : "Unable to read this PDF document.",
          );
        }

        const pageCount = pdfDoc.numPages;
        if (pageCount > maxPages) {
          throw new DocConvertError(
            "PDF_TOO_MANY_PAGES",
            `This PDF has ${pageCount} pages, exceeding the ${maxPages}-page import limit.`,
          );
        }

        const pageTexts: string[] = [];
        let cumulativeChars = 0;

        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
          if (signal.aborted) {
            throw new DocConvertError(
              "CONVERSION_TIMEOUT",
              "Extracting text from this PDF took too long and was stopped.",
            );
          }
          const page = await pdfDoc.getPage(pageNumber);
          try {
            const textContent = await page.getTextContent();
            const text = reconstructPageText(textContent.items);
            if (text) {
              cumulativeChars += text.length;
              if (cumulativeChars > maxChars) {
                throw new DocConvertError(
                  "PDF_TEXT_TOO_LARGE",
                  "This PDF contains more text than can be safely imported into the browser editor.",
                );
              }
              pageTexts.push(text);
            }
          } finally {
            page.cleanup();
          }
        }

        const plainText = pageTexts.join("\n\n").trim();
        const warnings: string[] = [
          "PDF import extracts text only; layout, tables, and visual styling are not preserved.",
        ];
        if (!plainText) {
          warnings.push(
            "No selectable text was found in this PDF (it may contain scanned images only).",
          );
        }

        const htmlParagraphs = plainText
          ? plainText
              .split(/\n{2,}/)
              .map((para) => {
                const lines = para
                  .split("\n")
                  .map((l) => escapeHtml(l.trim()))
                  .filter(Boolean);
                return lines.length > 0 ? `<p>${lines.join("<br>")}</p>` : "";
              })
              .filter(Boolean)
              .join("")
          : "";

        const sanitizedHtml = sanitizeDocumentHtml(htmlParagraphs);
        const markdown = htmlToMarkdown(sanitizedHtml);

        await pdfDoc.cleanup();
        return {
          plainText,
          sanitizedHtml,
          markdown,
          pageCount,
          warnings,
        };
      } finally {
        await loadingTask.destroy().catch(() => {});
      }
    },
    options?.timeoutMs,
    () => activeDestroy?.(),
  );
}
