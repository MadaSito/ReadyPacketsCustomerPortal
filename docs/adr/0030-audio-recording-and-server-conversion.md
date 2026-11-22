# 0030 — Audio is recorded in the browser and converted to WebM by a sandboxed worker job

Status: Accepted (2026-11-21; owner confirmation requested)

## Context
The owner asked for audio upload, in-browser recording and conversion to WebM.

## Decision
- Recording uses the browser's MediaRecorder; nothing is sent until the user uploads.
- Conversion to WebM / Opus runs `ffmpeg` (a system package) from a worker job: argument array, no shell, `file` protocol only, no network, time / size / duration limits. The original is kept and the result is a derived file that is classified again before it is visible.
- When `ffmpeg` is absent the feature reports that conversion is unavailable; uploads still work.

## Consequences
`ffmpeg` becomes an installation prerequisite for this feature and must be kept patched by the operator.
