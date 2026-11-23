# Word Documents in the Portal and Document Import (`D9` & `D12`)

## Editing Word (`.docx`) Files in the Portal
- Customers and authorized staff can open `.docx` files attached to an order directly in the portal editor from the order's **Files** tab or from a **Document response** task (`respond_document`).
- Conversion and editing run inside the user's browser under a 10 MB size ceiling (configurable via the Files setting `files.document_edit_max_bytes` / `files.document_edit_enabled`). Draft text is held only in page memory and is never persisted to browser storage.
- Saving always creates a **new `.docx` version** (`Save as new version`) and records version lineage (`Edited from vN`) while keeping the original uploaded `.docx` intact and downloadable at any time.
- If an order requires an unsigned agreement (`AGREEMENT_REQUIRED`), the editor opens in read-only mode and links the customer back to the order to sign the agreement before saving changes.
- **Formatting scope**: Supported formatting includes headings (`H1`–`H4`), bold, italic, underline, strikethrough, blockquotes, alignment, bulleted/numbered lists, `https://`/`mailto:` links, and tables. Running headers/footers, tracked changes, margin comments, floating text boxes/shapes, footnotes/endnotes, dynamic fields, and exact desktop fonts/pagination are not preserved when saving from the browser; the portal detects and lists these items before the user saves.

## Importing Policy Drafts from `.docx`, `.md`, or `.pdf`
- Administrators drafting policies can use **Import from file (.docx, .md, .pdf)** (`DocumentImportButton`) to convert an existing `.docx`, `.md`, or text-based `.pdf` (up to 10 MB and 200 pages) into sanitized policy content in the browser for review before saving a policy draft. Scanned image-only PDFs surface a clear warning because optical character recognition (OCR) is not performed.
