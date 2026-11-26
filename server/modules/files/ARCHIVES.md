# File archives (increment 07, package J, D8) — interface

Owner: portable_contract_engineer. These files live in `server/modules/files` by agreement with files_engineer: `archives*.ts`, `archivesSchema.ts`, `archivesRouter.ts`, `archivesHttp.ts` and this document. Client code is in `client/src/features/files/archives/`. Status: interface published; implementation in progress.

## What it does

- **Phase ZIP** (`scope: "stage"`): available to anyone who may see the phase's files. Files' `listDeliverableFiles(principal, { orderPublicId, stageKey })` decides who that is.
- **Whole-order ZIP** (`scope: "order"`): administrators only, with `files.archive.order` and a fresh step-up.
- **Built by a job** (`files.archive.build`) from a fixed manifest captured when the archive is requested: file public id, version, size, sha256 and the entry name the server derives. Members come from Files' deliverable selector only, so placeholders, removed rows and superseded versions are never included.
- **Re-authorised three times:**
  - At request, by the live session, the capability and the selector.
  - At build, by `openDeliverableFile` for every entry, as the requester's live session (the real principal from `identity.sessions.principalForJob`, which must be the same user and session, in state full with no pending steps; any refusal fails the build with `ARCHIVE_SESSION_ENDED`). If any entry is no longer eligible, the build fails with `ARCHIVE_STALE` and nothing old is exported silently.
  - At download, by the live session, the same session as the request, the capability and step-up again, and the selector for every member (count and versions must still match).
- **Caps:** 250 files and 500 MiB uncompressed. Larger sets are refused with `ARCHIVE_TOO_LARGE`, and nothing is cut silently. Each account can have one active archive (queued, building or ready) across processes.
- **Retries:** within the same session and scope, clicking Download again resumes queued/building work or reuses a ready archive whose manifest still matches. The click issues a fresh single-use ticket once ready. A stale ready archive is revoked and rebuilt. A valid request in another scope or after signing in through a new session supersedes the previous archive and is audited; old tickets never transfer.
- **Expiry:** archives expire 30 minutes after they are requested. The object is deleted on expiry, revocation or failure.
- **Entry names:** NFC, with control characters, `/`, `\`, `:` and leading dots replaced. Names are never absolute and never contain `..`, are at most 120 characters (extension kept), and get ` (2)`-style suffixes when names collide case-insensitively. Phase ZIPs are flat. Order ZIPs use one folder per phase plus `Order files/` for files that have no phase.
- **Download:** a single-use, account- and session-bound ticket that lasts 60 seconds (hashed at rest), then `POST /api/files/archives/download` with `{ ticket }` in the body. The response is streamed with `Content-Type: application/zip`, never through a bearer URL.
  - The `Content-Disposition` filename uses the order reference and customer phase label slug (for example, `RP-JJG5-ZEUGRE-ICEQUE-001-phase-1-intake.zip`), or the order reference and `-all-files.zip`, in both `filename` and `filename*`.
  - Ticket semantics: only a ticket bound to the caller's account and current session is consumed (atomically, committed before admission), so a refused admission still burns it; a ticket presented by anyone else is refused and left untouched. Admission (live session, archive row, order fence via the Files selector, fixed-manifest comparison, audit row, object open) runs in one transaction; only the byte stream continues after commit. A manifest mismatch revokes the archive (`ARCHIVE_STALE`).
  - `status` / `latest` re-check current order access under the order fence; a requester who lost access gets `NOT_FOUND` / `null` (no metadata or counts).
  - Foreign requester (another user's archive id): `NOT_FOUND`, reason `ARCHIVE_NOT_FOUND`, plus a `file.archive.denied` audit row.
- **Audit (file category):**
  - `file.archive.requested`, `file.archive.built`, `file.archive.failed`, `file.archive.ticket_issued`, `file.archive.downloaded` (attempted then completed or failed), `file.archive.denied` and `file.archive.expired`.
  - Recorded facts: `order_public_id`, `stage_key`, `scope`, file count and bytes.
  - Never recorded: member file names or object keys.

## Server

```ts
// server/modules/files/archives.ts
export function createFileArchivesModule(deps: ModuleDeps): FileArchivesModule; // → services.fileArchives
export const ARCHIVE_BUILD_JOB = "files.archive.build";
export const ARCHIVE_EXPIRE_JOB = "files.archive.expire"; // schedule "files.archive.expire.minutely"

export interface ArchiveView {
  archiveId: string;            // public id
  orderId: string;              // order public id
  scope: "stage" | "order";
  stageKey: string | null;
  state: "queued" | "building" | "ready" | "failed" | "expired" | "revoked";
  reasonCode: string | null;    // e.g. ARCHIVE_STALE, ARCHIVE_TOO_LARGE, ARCHIVE_EMPTY
  fileCount: number;
  totalBytes: number;
  zipBytes: number | null;
  createdAt: string; builtAt: string | null; expiresAt: string;
}
```

tRPC, mounted by /root as `fileArchives` (`server/modules/files/archivesRouter.ts`, `fileArchivesRouter`):

| Procedure | Who | Input → output |
|---|---|---|
| `request` (mutation, expensive) | stage: any full session allowed by the selector; order: admin + `files.archive.order` (step-up) | `{ orderId, stageKey? }` → `ArchiveView`. Resumes or reuses a matching active archive; otherwise an authorised request with eligible files replaces the previous active archive. |
| `status` (query) | the requester only | `{ archiveId }` → `ArchiveView` |
| `latest` (query) | the requester | `{ orderId, stageKey? }` → `ArchiveView \| null` (button state) |
| `cancel` (mutation) | the requester | `{ archiveId }` → `ArchiveView` (revoked) |
| `issueDownloadTicket` (mutation) | the requester, same session, ready state | `{ archiveId }` → `{ ticket, expiresAt }` |

HTTP: `registerFileArchiveHttpRoutes(router: Router, services: Services)` in `archivesHttp.ts` adds `POST /archives/download` under the existing `/api/files` router. Mounting it takes one line in `files/http.ts` (files_engineer). It uses the same CSRF, Origin, rate-limit and `sendPrivateDownload` rules as `/api/files/download`.

Dependencies on Files (files_engineer): `listDeliverableFiles` and `openDeliverableFile`, as published. Each `FileRecord` needs `stageKey` (null if the file has no phase) for folder grouping in order ZIPs.

## Client

`client/src/features/files/archives/ArchiveAction.tsx`:

- `PhaseArchiveAction({ orderId, stageKey })`: for the customer phase view (wizard).
- `OrderArchiveAction({ orderId })`: for the console Files tab (admin only; renders nothing without the capability).

Both show a "Download phase files (ZIP)" or "Download all order files (ZIP)" button. While the archive is being prepared they show progress in a polite live region, then download through a hidden form POST, which saves the file without a URL. The step-up prompt uses the existing step-up dialog. They work at 320 px and in both themes.

## Tables (migration 0007, additive)

- `file_archives`: id, public_id, order_id, order_public_id, scope enum(stage, order), stage_key varchar(64) null, requested_by_user_id, session_id varchar(80), active_user_id null (unique), state enum, reason_code, manifest json, file_count, total_bytes, zip_bytes, zip_sha256, object_key_enc text, job_id, expires_at, built_at, download_count, last_downloaded_at, purged_at, version, created_at.
- `file_archive_tickets`: id, token_hash char(64) unique, archive_id, user_id, session_id varchar(80), issued_at, expires_at, used_at.

Both are short-lived operational rows. They are not in portable packages (manifest exclusion `file-archives`) and are dumped by backups.

## Verification (increment 07)

- **Tested (`archives.test.ts`, real MySQL and in-memory storage):**
  - Entry names: traversal, reserved names and separators; case-insensitive dedupe; 30 duplicates at maximum length terminate, stay unique, ≤120 characters with the extension kept.
  - Caps: 251 files, more than 500 MiB and empty sets are refused.
  - Requests: queued/building resume, ready reuse and fresh tickets, stale replacement, scope/session supersession with one active slot; whole-order ZIP needs admin and step-up on request and ticket issue; another user's archive and an archive after access is lost are hidden.
  - Build: a ZIP read back with yauzl; a hash mismatch fails the build; an ended session fails the build.
  - Real Identity sessions (real `createIdentityModule`, and the fake Files port calls the real `sessions.assertCurrent`): a customer phase ZIP builds and downloads; an admin whole-order ZIP after a fresh step-up is ready with 2 files; a revoked session fails the build with `ARCHIVE_SESSION_ENDED` and stores no object. These cover the earlier `SESSION_NOT_CURRENT` failure from live QA.
  - Tickets and lifetime: single use; another session's ticket is refused without burning it; expiry; a manifest change before download revokes the archive; the expire job purges the object.
- **Client (`ArchiveAction.test.tsx`, jsdom):** queued → ready under StrictMode submits one native form POST with only `ticket` + `csrf`, makes no fetch, removes the form, keeps focus on the button and passes axe; a refused download (archive revoked as stale) is reported in the polite status line; a retry after an interrupted submission uses a fresh ticket.
- **Type-checked and linted, not run:** `archivesRouter.ts` and `archivesHttp.ts` (including the 204 answer to a refused form POST). No real browser, mobile or screen-reader run.
- **Download flow (browser):** a native top-level form POST (`application/x-www-form-urlencoded`, fields `ticket` and `csrf`) to `/api/files/archives/download`. The browser streams the attachment to disk; the page never holds the ZIP. The app layer (http_security_engineer) accepts the form only on this exact path, checks Origin, full session and the cookie + session-bound CSRF token, and hands the route a strict `{ ticket }`. A refusal inside the route answers `204 No Content` so the page stays put. The client then reads `downloadCount` from `status` to tell the user whether the download started. The sandboxed preview build refuses the form path and keeps a fetch fallback.
- **Known limits:** refusals raised before the route (origin, CSRF, session) are JSON responses and would navigate away from the page. A real Files selector and the real job runner have not been exercised together with this module.
