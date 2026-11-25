# 0059 — Phase-bound files: governance, playback grants with range requests, ZIP archives

Status: Accepted (2026-11-25, after the lead's integrated QA of increment 07 at `7c6bb71`; verification in [STATUS.md](../application-context/STATUS.md#verification-for-increment-07))

## Context
The owner listed potential features, including:
- order- and phase-scoped uploads, with separate recording and prerecorded-audio intents;
- configurable counts, sizes and durations;
- organisation by phase, category, visibility and version;
- phase ZIP and administrator bulk downloads;
- account-bound playback tickets with range streaming;
- access logging, with placeholders excluded from deliverables.

Files are quarantined, type-checked and downloaded through authorised routes today ([ADR 0030](0030-audio-recording-and-server-conversion.md), [ADR 0047](0047-recording-and-preflight.md)).

## Decision
- **Phase binding.** Each upload is bound to a phase. `stage_key` is stored on the file and never derived later from the current status. Document, recording and prerecorded audio are separate intents, resolved through `resolveStageForUpload(order, stageKey, intent)`.
- **Governance per phase:**
  - limits: `documentCount`, `documentMaxBytes`, `audioCount`, `audioMaxBytes`, `recordingMaxSeconds` and `totalAudioMaxSeconds`;
  - a blank limit means the platform limit, and the tightest of platform, phase and task applies;
  - audio duration is measured on the server. It is never trusted from the client and never treated as zero.
- **Views.** Files are grouped by phase, category, visibility and version, for the customer and in the console.
- **Playback.**
  - A single-use ticket, consumed within one minute, becomes a playback grant: a scoped HttpOnly cookie, valid for ten minutes and bound to the account and session.
  - `GET` and `HEAD /api/files/playback/:grantPublicId` answer 200 or a single-range 206. An invalid or unsatisfiable range gets 416, `HEAD` ignores `Range`, and an `If-Range` request gets the full file.
  - Each access rechecks scope, the immutable file version, visibility and the session, and is logged with a correlation id.
  - No bearer token is ever placed in a URL. The proxy passes range requests through unbuffered.
- **ZIP archives** (`file_archives`):
  - **Phase ZIP.** For anyone who may see the phase's files.
  - **Whole-order ZIP.** For administrators, with `files.archive.order` and step-up.
  - **How they are built.** A job builds each archive from a fixed manifest. Access is re-authorised at build and at download.
  - **Limits.** At most 250 files or 500 MiB. Archives expire after 30 minutes, and entry names are made safe.
  - **Contents.** Only current, customer-visible versions. For audio this is the WebM/Opus copy, not the original. Placeholders, removed rows and superseded versions are never included.
  - **Logging.** Every access is logged.

## As implemented

From the owners' [files API](../../server/modules/files/API.md), [archive notes](../../server/modules/files/ARCHIVES.md) and the lead's QA rulings:

- **Uploads on phases orders.** On a format-3 order, every customer upload must name the current open or reopened phase and an enabled upload action, otherwise it is refused with `STAGE_REQUIRED`. Orders pinned to formats 1 and 2 keep phase-less uploads unchanged.
- **WAV and other audio.** The original is kept, and a WebM/Opus copy is added (a re-encode).
- **ZIP requests.** Asking again for the same scope resumes or reuses the archive. A different scope supersedes the earlier archive, and this is audited. Each account has one active archive. File names are `<order ref>-<phase slug>.zip` or `<order ref>-all-files.zip` (`7c6bb71`).
- **ZIP download.** The download is a native form POST with a single-use, account- and session-bound ticket, a session and a form CSRF token. Because the portal sends `Referrer-Policy: no-referrer`, browsers send `Origin: null` on it. That value is accepted only for this exact form, and only with `Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest` of `document` or `empty`. Refusals inside the route answer 204 (`5a0a492`).
- **Audit.** The File category records `file.archive.{requested, built, failed, ticket_issued, downloaded, denied, expired}`, never member file names.
- **Lead QA.** In a browser, the lead checked phase uploads (a PDF accepted, a disguised file refused, WAV to a WebM copy, the allowance countdown), a single download, 206 range playback, phase ZIP for a customer and for staff, and a whole-order ZIP behind step-up.

## Assumptions to confirm with the owner
- Phase ZIP is on after upgrade. Whole-order ZIP is for administrators only.
- The 250-file / 500 MiB / 30-minute limits suit the owner's orders.

## Consequences
- Files stay with the phase they were uploaded in, even if the order later moves on or back.
- Large orders may need several phase ZIPs instead of one whole-order ZIP.
