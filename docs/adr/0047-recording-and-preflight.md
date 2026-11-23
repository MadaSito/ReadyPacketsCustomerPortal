# 0047 — Recording on orders from any device, with a preflight check

Status: Proposed (drafted from INCREMENT_06_CONTRACT.md D2; to be corrected against `server/modules/files/API.md` when package B lands)

## Context
The owner asked for audio recording on orders from any device, with a test run beforehand. WebM is the target format. Apple devices should record in their most compatible format, and the recording should then be converted to WebM. Increment 04 added browser recording and a sandboxed FFmpeg conversion job ([ADR 0030](0030-audio-recording-and-server-conversion.md)), but it was switched off by default. Safari on iOS records MP4/AAC rather than WebM.

## Decision
- **Where.** A visible **Record** button appears wherever audio is accepted: the order's files panel and a phase task of kind `record` ([ADR 0051](0051-phase-tasks.md)).
- **Format chosen at runtime.** The browser picks the first format that `MediaRecorder.isTypeSupported` accepts, in this order:
  1. `audio/webm;codecs=opus`
  2. `audio/webm`
  3. `audio/mp4;codecs=mp4a.40.2`
  4. `audio/mp4`
  5. `audio/ogg;codecs=opus`
  6. the browser default

  Recording uses a 1-second timeslice, so MP4 on iOS does not stall. Each recording is labelled with the type the recorder actually used.
- **Fallback.** Without `MediaRecorder`, or when the microphone is refused, the device's own recorder is offered (`<input type="file" accept="audio/*" capture>`), and ordinary upload remains available.
- **Conversion.** Anything that is not WebM/Opus (`.m4a`, `.mp4`, `.ogg`, `.wav`, `.mp3`, `.aac`, `.caf`) is converted on the server to WebM/Opus by the existing FFmpeg job.
  - `files.audio_conversion` now defaults to `{ enabled: true, keepOriginal: true, bitrateKbps: 128, maxMinutes: 30 }`. The bitrate can be 24–256 kbps and the length limit 1–120 minutes.
  - Sample rate and channels are preserved, up to 48 kHz stereo.
  - The WebM is what the order shows and what goes to production. The original is kept while `keepOriginal` is on, and staff can download it.
- **Honest wording.** The conversion is high quality, but AAC → Opus is a re-encode, not a bit-identical copy. The kept original is the lossless record. This wording is used in the UI and the guides.
- **Missing FFmpeg.** The upload is still stored and marked "conversion pending/unavailable", and administrators see a health warning on `/admin/files`.
- **Preflight** (`RecordingPreflight`) runs before the first recording and on demand. It checks:
  - a secure context;
  - recorder support and the chosen format;
  - microphone permission, with recovery text for each browser;
  - the input device, with a picker;
  - a live level meter with a "we can hear you" threshold;
  - a 5-second test recording with playback, including the iOS silent-switch hint;
  - the server, through `files.recording.preflight`, which returns `{ enabled, conversionAvailable, maxMinutes, maxBytes, acceptedTypes }`.

  Each check shows pass, warn or fail in text, not colour only. Results are announced politely and can be re-run. The test recording never leaves the device.
- **Limits and controls.** Limits come from the phase task when it sets them, otherwise from the setting. The elapsed and remaining time are shown, pause and resume remain, and a wake lock is requested while recording where the browser offers one.

## Assumptions to confirm with the owner
- Recording and conversion are on after upgrade, because they need no configuration. Operators without FFmpeg see "conversion unavailable" instead of an error.
- "Without losing anything" is met by keeping the original. The converted WebM is a high-quality re-encode, not lossless.

## Consequences
- Recordings work on Safari (iOS, iPadOS and macOS), Chromium and Firefox through one code path, with a device fallback.
- Storage use roughly doubles for non-WebM recordings while `keepOriginal` is on.
- The nginx upload limit must allow the largest recording (see `docs/operations/UPGRADE.md`, increment 06).
