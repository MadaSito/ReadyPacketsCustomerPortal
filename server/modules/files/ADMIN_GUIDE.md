# Workflow uploads and audio administration

Use the workflow designer to define document and audio slots on a status. Set the authorized upload actors, minimum and maximum file counts, and allowed extensions. The type rules under Console → Files also apply. Workflow slots accept only customer-visible files; a general upload never fills a requirement. A replacement preserves its slot and scope; earlier versions, deleted files, and converted copies do not count.

## Audio conversion

In Console → Files, open Audio recording and conversion. The feature is disabled by default; changes require recent step-up verification. Configure the maximum duration (1–20 minutes, default 5) and Opus bitrate (24–128 kbps, default 48). Keeping the original is mandatory. This setting does not enable access to another customer's order. Previously uploaded audio is not automatically backfilled.

Install the supported OS packages FFmpeg and util-linux in the worker environment. Set `RP_FFMPEG_PATH` only in the deployment, to a trusted absolute executable path, if it differs from `/usr/bin/ffmpeg`. `/usr/bin/prlimit` and Linux `/proc` file-descriptor access are required. Use a private service account and storage root inaccessible to other users, retain the existing worker sandbox, and keep both packages patched. Check the audited admin settings and the `files.audio` health component after enabling. Verify with a synthetic upload on staging before permitting real recordings.

Conversion uses a local restricted process without network protocols. Inputs are rehashed into a private temporary directory and outputs are checked before publication. A missing executable, an input above the duration limit, or another conversion failure leaves the original available under the existing access rules. If the job repeatedly loses its lease or its audited write fails, inspect `files.audio_conversion` in the job center and use its manual retry when eligible. Incidents can be cross-referenced with `file.audio.conversion` via job and correlation IDs. Never put audio bytes, transcript text, or local storage paths in a support ticket or log export.

## Protected transcript access

An optional plain-text transcript is encrypted in the application and is not returned by file listings or the public file metadata API. Reading it uses the same file/order authorization as reading the recording and generates a dedicated file audit event. Audio and transcripts may contain sensitive information; define retention, access, and recording-consent practices appropriate to the deployment.
