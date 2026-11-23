# 0052 — Editing Word documents in the portal

Status: Proposed (drafted from INCREMENT_06_CONTRACT.md D9; to be corrected against `client/src/lib/docconvert`, `client/src/features/docedit` and `server/modules/files/API.md`)

## Context
The owner asked that customers can edit Word documents in the portal. Running document parsers on the server widens the attack surface (ZIP bombs, XML attacks, parser bugs). A browser editor cannot reproduce all of Word's layout.

## Decision
- **Conversion in the browser only.** The converters live in `client/src/lib/docconvert/` and are lazy-loaded. No parser runs on the server, which keeps validating every stored file as today.

  | Converter | Library | Notes |
  | --- | --- | --- |
  | `docxToHtml` | `mammoth` | the output passes through the existing HTML sanitiser before it reaches the editor |
  | `editorToDocx` | `docx` | |
  | `pdfToText` | `pdfjs-dist` | worker from the same origin, `isEvalSupported: false`, no remote fonts or cmaps |
  | `markdown` | | |

- **Guards:**
  - a 10 MB input limit;
  - a ZIP entry count and size-ratio check before parsing;
  - 200 pages for PDF;
  - a time limit;
  - a clear failure message.

  The CSP stays strict, with no `unsafe-eval`.
- **Editor** (`client/src/features/docedit`):
  - A user opens a `.docx` they may read on an order and edits it in the existing rich-text editor. It supports headings, paragraphs, bold, italic, underline, strike, lists, links, tables, alignment and images already in the document.
  - **Save as new version** uploads a new `.docx` through the normal upload path, linked to its source (`derivedFromFileId`, version number) and visible in the file's version history. The original is never changed.
  - Draft autosave is in memory only; document content is never put in local storage.
  - Leaving with unsaved changes shows a warning.
- **Honest limits.** Before editing, the user is told what the editor does not keep: headers and footers, tracked changes, comments, text boxes, footnotes, complex fields, and exact fonts and page layout. When such content is detected, the warning lists it. The original remains available.
- **Who may edit:**
  - customers, on their own orders, for files they may read, where the order or phase allows uploads (a `respond_document` task with `edit_in_portal`, or an order that accepts customer documents);
  - staff and administrators, on files they may manage.
- **Setting.** `files.document_editing` `{ enabled: true, maxBytes }`.
- **Files port** (files_engineer):
  - read-as-blob for the editor;
  - `saveEditedVersion`, which checks ownership, phase rules, the order agreement gate ([ADR 0053](0053-policy-notices-and-enforcement.md)), type and size, and records the audit event `file.edited_version_created`;
  - version listing.
- **`DocumentImportButton`.** A reusable control: the user picks a `.docx`, `.md` or `.pdf`, and it returns sanitised editor content with a list of conversion warnings. Policy import uses it.

## Assumptions to confirm with the owner
- Editing is on after upgrade.
- A saved edit is always a new version; nobody can overwrite the original from the portal.

## Consequences
- Simple documents (text, headings, lists, tables) round-trip well. Complex Word documents lose the features listed above in the edited version, and the original stays the reference.
- The browser does the conversion work, so very large documents are refused rather than slowing the server.
