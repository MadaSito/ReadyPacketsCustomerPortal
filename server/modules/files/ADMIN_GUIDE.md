# Workflow uploads and audio administration

Use the workflow designer to define document and audio slots on a status. Set the authorized upload actors, minimum and maximum file counts, and allowed extensions. The type rules under Console → Files also apply. Workflow slots accept only customer-visible files; a general upload never fills a requirement. A replacement preserves its slot and scope; earlier versions, deleted files, and converted copies do not count.

## Phase files and governance

For phase-based workflows, configure separate document upload, recording, prerecorded audio, and team-file review actions. Set document and audio counts, maximum bytes per file, maximum recording seconds, and total audio seconds in the phase. A blank limit inherits the platform ceiling. The service applies the narrowest of phase, task, and platform limits; it counts current originals, never derivative copies, and verifies every newly admitted audio duration from staged bytes. Restoring an item must fit the current phase's capacity.

In Console → Orders → Files, select a reached phase and upload action before adding a file. To publish a team file for review, select Deliverable and Customer-visible. Existing files stay bound to their original phase even when the status changes. For phase-managed audio, configured Originals and Conversion Staging destinations may receive an admitted original; Intake Delivery receives a current native WebM/Opus file or an admitted derivative, never an unconverted fallback. Earlier remote copies are kept.

Search the audit center by the order, file or correlation ID to review access attempts and outcomes. Playback events use `file.playback.*`, and opening an eligible file for an archive records `file.deliverable.open`. Do not include playback cookies, tickets, file names, or transcripts in operational logs.

## Audio conversion

In Console → Files, open Audio recording and conversion. It is enabled by default; an existing explicit setting is preserved, and changes require recent step-up verification. Configure the maximum duration (1–120 minutes, default 30) and Opus bitrate (24–256 kbps, default 128). A recording task can specify its own duration. Keeping the original is mandatory. This setting does not enable access to another customer's order or backfill previously uploaded audio.

Install the supported OS packages FFmpeg and util-linux in the worker environment. Set `RP_FFMPEG_PATH` only in the deployment, to a trusted absolute executable path, if it differs from `/usr/bin/ffmpeg`. `/usr/bin/prlimit` and Linux `/proc` file-descriptor access are required. Use a private service account and storage root inaccessible to other users, retain the existing worker sandbox, and keep both packages patched. Check the audited admin settings and the `files.audio` health component after enabling. Verify with a synthetic upload on staging before permitting real recordings.

Re-encoding uses a local restricted process without network protocols. It creates a WebM/Opus copy, not a bit-identical original, and keeps the original file. Inputs are rehashed into a private temporary directory and outputs are checked before publication. A missing executable or conversion failure leaves an admitted original available and reports degraded health when the executable is missing. A duration-limited task must be verifiable before publication; standard PCM WAV can be checked without FFmpeg, while other formats may be refused until the decoder is available. Check file and request size limits separately for long or high-bitrate inputs.

The customer’s default library shows the WebM copy when available. Automatic production copies in configured order storage send only current WebM/Opus when conversion succeeds. If disabled or unsuccessful, the fallback copy is labeled `(unconverted)` in the destination filename and transfer log. Staff can download the unmodified original from portal storage; it remains in backups. Previously copied originals are not removed, and retries do not duplicate a copy of the same file version to the same destination. Inspect `files.audio_conversion` in the job center if conversion or its audit fails. Cross-reference `file.audio.conversion` by job and correlation IDs; never include audio, transcripts, or local storage paths in support tickets or exported logs.

## Word documents

Word document editing in Console → Files is enabled by default up to 10 MiB, subject to the platform DOCX and upload limits. Configure the effective limit and switch off editing independently of general DOCX uploads. Save creates a version through the regular admission and scanning pipeline; it never overwrites a stored source. An edited workflow reply does not replace the staff source.

## Protected transcript access

An optional plain-text transcript is encrypted in the application and is not returned by file listings or the public file metadata API. Reading it uses the same file/order authorization as reading the recording and generates a dedicated file audit event. Audio and transcripts may contain sensitive information; define retention, access, and recording-consent practices appropriate to the deployment.
