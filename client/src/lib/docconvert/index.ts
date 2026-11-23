/**
 * Public barrel for browser-only document conversion & import helpers (`@/lib/docconvert`).
 * Owner: Package C (`integrations_engineer`). Never import from `server/`.
 */
export {
  DEFAULT_CONVERT_TIMEOUT_MS,
  DOCX_MIME,
  DocConvertError,
  MAX_DOCCONVERT_BYTES,
  MAX_PDF_EXTRACTED_CHARS,
  MAX_PDF_PAGES,
  MAX_ZIP_COMPRESSION_RATIO,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_SINGLE_ENTRY_BYTES,
  MAX_ZIP_UNCOMPRESSED_BYTES,
  orderDocumentEditHref,
  type ConvertGuardOptions,
  type DocConvertErrorCode,
  type DocConvertOptions,
  type DocxToHtmlResult,
  type DocxUnsupportedFeature,
  type DocxUnsupportedFeatureKey,
  type DocumentImportResult,
  type DocumentImportSourceKind,
  type EditorToDocxOptions,
  type EditorToDocxResult,
  type ImportedDocumentSourceFormat,
  type MarkdownConvertResult,
  type MarkdownImportResult,
  type OrderDocumentEditHrefOptions,
  type PdfToTextOptions,
  type PdfToTextResult,
} from "./types";

export {
  assertInputSize,
  assertPdfHeader,
  detectDocxUnsupportedFeaturesFromXml,
  effectiveMaxBytes,
  inspectZipArchive,
  toOwnedArrayBuffer,
  toUint8Array,
  verifyZipActualInflation,
  withConversionTimeout,
  type ZipEntryMeta,
  type ZipGuardOptions,
  type ZipInspectionResult,
} from "./guards";

export {
  htmlToPlainText,
  isAllowedDocumentHref,
  isAllowedDocumentImageSrc,
  MAX_DOCUMENT_HTML_DEPTH,
  MAX_DOCUMENT_HTML_NODES,
  MAX_INLINE_IMAGE_DATA_URI_CHARS,
  sanitizeDocumentHtml,
  sanitizeDocumentHtmlWithWarnings,
  type DocumentTextAlignment,
  type SanitizeDocumentResult,
} from "./sanitize";

export { htmlToMarkdown, markdownToHtml } from "./markdown";
export { docxToHtml } from "./docxToHtml";
export { editorToDocx } from "./editorToDocx";
export { pdfToText, type PdfConvertOptions } from "./pdfToText";
export {
  detectImportSourceKind,
  DocumentImportButton,
  importDocumentFile,
  type DocumentImportButtonProps,
} from "./DocumentImportButton";
