# 0059 — Phase-bound files: governance, playback grants with range requests, ZIP archives

Status: Proposed (drafted from INCREMENT_07_CONTRACT.md; to be corrected against the owners' API.md as packages land)

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
  - Playback grants are short-lived and bound to the account and session.
  - A `GET` asks for a single byte range and gets a 206 answer.
  - Grants are revoked on hide, replacement, removal and session end.
  - No bearer token is ever placed in a URL. The proxy passes range requests through unbuffered.
- **ZIP archives** (`file_archives`):
  - **Phase ZIP.** For anyone who may see the phase's files.
  - **Whole-order ZIP.** For administrators, with `files.archive.order` and step-up.
  - **How they are built.** A job builds each archive from a fixed manifest. Access is re-authorised at build and at download.
  - **Limits.** At most 250 files or 500 MiB. Archives expire after 30 minutes, and entry names are made safe.
  - **Contents.** Placeholders, removed rows and superseded versions are never included.
  - **Logging.** Every access is logged.

## Assumptions to confirm with the owner
- Phase ZIP is on after upgrade. Whole-order ZIP is for administrators only.
- The 250-file / 500 MiB / 30-minute limits suit the owner's orders.

## Consequences
- Files stay with the phase they were uploaded in, even if the order later moves on or back.
- Large orders may need several phase ZIPs instead of one whole-order ZIP.
