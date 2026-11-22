# Storage Connections & SharePoint Order Sync Verification (`client/src/features/storage`)

## Security & Accessibility Gates Verified
1. **9 provider choices with native field names**: Amazon S3, Wasabi, Backblaze B2, Custom S3-compatible, Azure Blob Storage, Dropbox, Google Drive, SharePoint library, and OneDrive for Business — no raw JSON editors.
2. **Write-only credentials & re-bind protection**: Secrets are never echoed back; changing destination/client config when credentials are stored requires re-entering the secret or disconnecting OAuth first.
3. **Two-step Strict-cookie OAuth completion**: Reads `?oauth=finish#oauth-attempt=<43-char-handle>` once in a StrictMode-safe latch, strips query + fragment immediately via `history.replaceState`, refreshes `GET /api/csrf`, and posts `{ attemptHandle }` to `/api/storage/oauth/finish`.
4. **Honest remote revocation notice**: When `disconnect` returns `{ remoteRevoked: false }`, displays a prominent warning instructing the administrator to revoke the grant in the provider console.
5. **Test-gated enablement & SharePoint backfill**: Enabling connections or SharePoint sync requires passing provider verification; SharePoint order sync supports `Sync all existing orders now`, `Resume` / `Restart` on failed backfills, and paged per-order status.
6. **WCAG 2.2 AA & 320 px layout**: Designed and tested against WCAG 2.2 AA with `expectNoAxeViolations`, `pageA11y` (light and dark), keyboard-operable `Wizard`, and `ErrorState` on failed queries.
7. **Console Order File Sync Tab (`OrderFileSyncTab`, `orderFileSync.test.tsx` — 11/11 passing)**:
   - Dynamic tab label `"SharePoint sync (n)"` when SharePoint/OneDrive is assigned to `order_files` and `"File sync (n)"` otherwise (`key: "sync"`, `order: 60`, `access: "staff"`).
   - Customer isolation: never rendered in the customer portal and never issues `storage.copies.forOrder` for customer area or customer sessions.
   - Totals (`Total`, `Synced`, `In progress`, `Failed`), desktop transfer table (`>= 640 px`) that becomes stacked `<dl>` cards below `640 px` (`sm:hidden`), status badges with explicit text, and wrapping monospace target paths.
   - `Retry` button shown only for failed transfers whose local source still exists (`canRetry: true`) when the user holds `files.manage`; `Open Copy log` (`/admin/storage/copies?orderPublicId=<orderId>`) and empty-state `/admin/storage` link gated to administrators (`storage.copies.read` / `storage.manage`).
