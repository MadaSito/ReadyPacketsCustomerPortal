/**
 * Browser-only document conversion types, limits, safe errors, and shared route helpers (Increment 06 D9 & D12).
 * Never imported by `server/`.
 */

export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;

/** Hard browser conversion ceiling (10 MiB). */
export const MAX_DOCCONVERT_BYTES = 10 * 1024 * 1024;

/** Archive bomb & structural safety bounds for `.docx` ZIP containers. */
export const MAX_ZIP_ENTRIES = 1_000;
export const MAX_ZIP_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
export const MAX_ZIP_SINGLE_ENTRY_BYTES = 25 * 1024 * 1024;
export const MAX_ZIP_COMPRESSION_RATIO = 100;

/** Maximum page count and cumulative extracted text ceiling accepted by browser `pdfToText` (D9). */
export const MAX_PDF_PAGES = 200;
export const MAX_PDF_EXTRACTED_CHARS = 2_000_000;

/** Wall-clock conversion time limit per operation (D9). */
export const DEFAULT_CONVERT_TIMEOUT_MS = 15_000;

export type DocConvertErrorCode =
  | "FILE_EMPTY"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_FORMAT"
  | "UNSUPPORTED_FILE_TYPE"
  | "INVALID_DOCX_ARCHIVE"
  | "ZIP_TOO_MANY_ENTRIES"
  | "ZIP_UNSAFE_ENTRY_PATH"
  | "ZIP_UNCOMPRESSED_TOO_LARGE"
  | "ZIP_COMPRESSION_RATIO_EXCEEDED"
  | "WORKER_UNAVAILABLE"
  | "DOCX_PARSE_FAILED"
  | "DOCX_EXPORT_FAILED"
  | "INVALID_PDF_HEADER"
  | "PDF_TOO_MANY_PAGES"
  | "PDF_TEXT_TOO_LARGE"
  | "PDF_PARSE_FAILED"
  | "PDF_ENCRYPTED_OR_UNREADABLE"
  | "INVALID_UTF8_TEXT"
  | "MARKDOWN_INVALID_ENCODING"
  | "DOCUMENT_HTML_TOO_COMPLEX"
  | "CONVERSION_TIMEOUT"
  | "CONVERSION_FAILED";

export class DocConvertError extends Error {
  readonly code: DocConvertErrorCode;
  readonly safeMessage: string;

  constructor(code: DocConvertErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = "DocConvertError";
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

export type DocxUnsupportedFeatureKey =
  | "headers_footers"
  | "tracked_changes"
  | "comments"
  | "text_boxes"
  | "footnotes_endnotes"
  | "complex_fields"
  | "embedded_objects";

export interface DocxUnsupportedFeature {
  readonly key: DocxUnsupportedFeatureKey;
  readonly label: string;
  readonly detail: string;
}

export interface ConvertGuardOptions {
  /** Maximum accepted input bytes (capped at `MAX_DOCCONVERT_BYTES`, 10 MiB). */
  readonly maxBytes?: number;
  /** Maximum wall-clock duration in milliseconds (defaults to `DEFAULT_CONVERT_TIMEOUT_MS`). */
  readonly timeoutMs?: number;
}

export type DocConvertOptions = ConvertGuardOptions;

export interface DocxToHtmlResult {
  /** Sanitised HTML ready for the rich-text editor. */
  readonly sanitizedHtml: string;
  /** Safe Markdown representation preserving headings, lists, emphasis, links, and tables. */
  readonly markdown: string;
  /** Extracted plain text. */
  readonly plainText: string;
  /** Conversion notices and unsupported-feature warnings. */
  readonly warnings: string[];
  /** Specific OOXML constructs detected in the source `.docx` that the portal editor does not preserve. */
  readonly detectedUnsupported: DocxUnsupportedFeature[];
}

export interface EditorToDocxOptions extends ConvertGuardOptions {
  /** Optional document title metadata written to core properties. */
  readonly title?: string;
}

export interface EditorToDocxResult {
  readonly blob: Blob;
  readonly bytes: Uint8Array;
  readonly mimeType: typeof DOCX_MIME;
}

export interface PdfToTextOptions extends ConvertGuardOptions {
  /** Maximum accepted page count (clamped to `MAX_PDF_PAGES`, 200). */
  readonly maxPages?: number;
  /** Maximum cumulative extracted text characters (clamped to `MAX_PDF_EXTRACTED_CHARS`, 2,000,000). */
  readonly maxExtractedChars?: number;
}

export interface PdfToTextResult {
  readonly plainText: string;
  readonly sanitizedHtml: string;
  readonly markdown: string;
  readonly pageCount: number;
  readonly warnings: string[];
}

export interface MarkdownConvertResult {
  readonly sanitizedHtml: string;
  readonly markdown: string;
  readonly plainText: string;
  readonly warnings: string[];
}

export type MarkdownImportResult = MarkdownConvertResult;

export type ImportedDocumentSourceFormat = "docx" | "markdown" | "pdf";
export type DocumentImportSourceKind = ImportedDocumentSourceFormat;

export interface DocumentImportResult {
  readonly sourceFormat: ImportedDocumentSourceFormat;
  readonly sourceKind: DocumentImportSourceKind;
  readonly fileName: string;
  /** Sanitised HTML suitable for the rich-text editor. */
  readonly sanitizedHtml: string;
  /** Safe Markdown preserving headings, lists, emphasis, links, and tables (for `safe_markdown` policies). */
  readonly markdown: string;
  /** Extracted plain text (primary output for PDF). */
  readonly plainText: string;
  /** Recommended policy body format (`"plain_text"` for PDF, `"safe_markdown"` for Word/Markdown). */
  readonly suggestedPolicyFormat: "safe_markdown" | "plain_text";
  /** Human-readable conversion warnings to show before review/save. */
  readonly warnings: string[];
  readonly detectedUnsupported?: DocxUnsupportedFeature[];
  readonly pageCount?: number;
}

export interface OrderDocumentEditHrefOptions {
  readonly area?: "customer" | "console";
  readonly consoleView?: boolean;
  readonly taskKey?: string | null;
}

/**
 * Builds the portal route to open a `.docx` order file in the browser editor without cross-feature imports.
 */
export function orderDocumentEditHref(
  orderPublicId: string,
  filePublicId: string,
  options?: OrderDocumentEditHrefOptions,
): string {
  const isConsole = options?.area === "console" || options?.consoleView === true;
  const prefix = isConsole ? "/admin/orders" : "/orders";
  const base = `${prefix}/${encodeURIComponent(orderPublicId)}/documents/${encodeURIComponent(filePublicId)}/edit`;
  const taskKey = options?.taskKey?.trim();
  return taskKey ? `${base}?taskKey=${encodeURIComponent(taskKey)}` : base;
}
