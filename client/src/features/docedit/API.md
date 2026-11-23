# `client/src/features/docedit` — Portal Word Document Editor (Increment 06 D9)

## Registry Export (for `/root` in `client/src/app/registry.ts`)
```ts
import { doceditFeature } from "@/features/docedit/routes";
```
Add `doceditFeature` to `FEATURES` in `client/src/app/registry.ts`.

## Routes
- Customer area: `/orders/:orderId/documents/:fileId/edit` (`access: "customer"`, optional `?taskKey=<slotKey>` query parameter for `respond_document` tasks)
- Staff console: `/admin/orders/:orderId/documents/:fileId/edit` (`access: "staff"`, `capability: "orders.read_all"`, optional `?taskKey=<slotKey>`)

All callers construct URLs with `orderDocumentEditHref(orderId, fileId, { area, taskKey })` from `@/lib/docconvert` without importing `@/features/docedit`.

## Server Contracts Consumed
- `trpc.files.document.status({ orderPublicId, filePublicId, taskKey? })`
- `trpc.files.document.versions({ orderPublicId, filePublicId, taskKey? })`
- `trpc.files.issueDownloadTicket({ fileId })` + `POST /api/files/download`
- `GET /api/files/orders/:orderPublicId/:filePublicId/document?taskKey=...`
- `POST /api/files/orders/:orderPublicId/:filePublicId/document?taskKey=...` (multipart field `files`)

## Security, Privacy & Accessibility Invariants
- Designed and tested against WCAG 2.2 AA (roving-tabindex toolbar, labelled controls, 44 px coarse-pointer targets, responsive down to 320 px).
- Zero inline `style` attributes (`injectCSS: false`, `CspSafeTable`, `CspSafeTextAlign`, bundled `docedit.css`) so strict `style-src 'self'` holds.
- Zero browser persistence (`localStorage`, `sessionStorage`, and `indexedDB` are never read or written); unsaved changes are guarded via `beforeunload` and `ConfirmDialog`.
