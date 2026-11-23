# Browser Document Conversion & Import (`@/lib/docconvert`)

Owner: Package C (`integrations_engineer`). Browser-only module (`client/src/lib/docconvert`); **never** import from `server/`.

## Exports

- **Navigation helper** (`@/lib/docconvert` or `@/lib/docconvert/types`):
  - `orderDocumentEditHref(orderPublicId: string, filePublicId: string, options?: { area?: "customer" | "console"; consoleView?: boolean; taskKey?: string | null }): string`
    - Customer route: `/orders/:orderId/documents/:fileId/edit` (appends `?taskKey=...` when provided).
    - Staff Console route (`area: "console"` or `consoleView: true`): `/admin/orders/:orderId/documents/:fileId/edit`.

- **Converters** (heavy browser libraries `mammoth`, `docx`, `pdfjs-dist` are loaded lazily on demand):
  - `docxToHtml(input: ArrayBuffer | Uint8Array | Blob, options?: DocConvertOptions): Promise<DocxToHtmlResult>`
    - Enforces 10 MB byte limit, canonical ZIP Central-Directory <-> Local-Header coherence, unique entry paths, non-overlapping member spans, actual bounded deflate-stream inflation (50 MB total / 25 MB single entry / 100x ratio), OOXML unsupported-feature detection (`headers_footers`, `tracked_changes`, `comments`, `text_boxes`, `footnotes_endnotes`, `complex_fields`, `embedded_objects`), terminable same-origin Worker execution (fails closed with `WORKER_UNAVAILABLE` if Worker isolation is unavailable), and strict HTML sanitisation.
  - `editorToDocx(editorHtml: string, options?: DocConvertOptions): Promise<EditorToDocxResult>`
    - Sanitises HTML before building `.docx` (`blob`, `bytes`, `mimeType`), preserving headings (`h1`..`h4`), alignment (`data-text-align`), bold/italic/underline/strikethrough/inline code, `https:`/`mailto:` links, bullet & numbered lists, blockquotes, rules, tables (`colspan`, `rowspan`), and bounded embedded raster images.
  - `pdfToText(input: ArrayBuffer | Uint8Array | Blob, options?: PdfConvertOptions): Promise<PdfToTextResult>`
    - Same-origin bundled `pdf.worker.min.mjs?url`, `isEvalSupported: false`, `useWasm: false`, `disableFontFace: true`, `enableXfa: false`, 10 MB byte limit, clamped 200-page ceiling (`MAX_PDF_PAGES`), cumulative 2,000,000-character extracted-text cap (`MAX_PDF_EXTRACTED_CHARS`), and wall-clock timeout with `loadingTask.destroy()`.
  - `markdownToHtml(input: string | ArrayBuffer | Uint8Array | Blob, options?: DocConvertOptions): Promise<MarkdownImportResult>`
    - Strict UTF-8 decode, escapes raw HTML tags in source Markdown before parsing, supports headings, lists, emphasis, links, blockquotes, rules, and pipe tables, then runs `sanitizeDocumentHtml`.
  - `htmlToMarkdown(sanitizedHtml: string): string` & `htmlToPlainText(sanitizedHtml: string): string`.
  - `sanitizeDocumentHtml(rawHtml: string): string` & `sanitizeDocumentHtmlWithWarnings(rawHtml: string): SanitizeDocumentResult`
    - Inert `DOMParser` allow-list; zero inline `style` attributes so `style-src 'self'` CSP holds.

- **Reusable Import Control (`D12`)**:
  - `DocumentImportButton(props: DocumentImportButtonProps)` and `importDocumentFile(file: File, options?: DocConvertOptions): Promise<DocumentImportResult>`
    - Accepts `.docx`, `.md`/`.markdown`, and `.pdf`, returning `{ sourceKind, fileName, sanitizedHtml, markdown, plainText, warnings, pageCount?, detectedUnsupported? }`.
    - Designed and tested against WCAG 2.2 AA (`aria-describedby` format/size hint, keyboard-accessible button trigger, visible warning/error callouts).
