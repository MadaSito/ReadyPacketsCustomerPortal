# Storage Connections & SharePoint Order Sync Verification (`client/src/features/storage`)

## Security & Accessibility Gates Verified
1. **9 provider choices with native field names**: Amazon S3, Wasabi, Backblaze B2, Custom S3-compatible, Azure Blob Storage, Dropbox, Google Drive, SharePoint library, and OneDrive for Business — no raw JSON editors.
2. **Write-only credentials & re-bind protection**: Secrets are never echoed back; changing destination/client config when credentials are stored requires re-entering the secret or disconnecting OAuth first.
3. **Two-step Strict-cookie OAuth completion**: Reads `?oauth=finish#oauth-attempt=<43-char-handle>` once in a StrictMode-safe latch, strips query + fragment immediately via `history.replaceState`, refreshes `GET /api/csrf`, and posts `{ attemptHandle }` to `/api/storage/oauth/finish`.
4. **Honest remote revocation notice**: When `disconnect` returns `{ remoteRevoked: false }`, displays a prominent warning instructing the administrator to revoke the grant in the provider console.
5. **Test-gated enablement & SharePoint backfill**: Enabling connections or SharePoint sync requires passing provider verification; SharePoint order sync supports `Sync all existing orders now`, `Resume` / `Restart` on failed backfills, and paged per-order status.
6. **WCAG 2.2 AA & 320 px layout**: Verified with `expectNoAxeViolations`, keyboard-operable `Wizard`, and `ErrorState` on failed queries.
