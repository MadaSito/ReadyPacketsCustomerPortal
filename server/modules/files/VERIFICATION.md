# Private files verification

Use `source scripts/dev/env.sh` to select the project Node toolchain and local test database. Run `pnpm exec vitest run --maxWorkers 1 server/modules/files client/src/features/files` with the development MySQL instance running. The suite creates and removes its own isolated database and uses synthetic fixtures.

## Evidence and scope

- Files MySQL tests exercise the configured scanner before a clean PDF is staged for copy, derivative-first audio production routing, the marked original fallback, bounded transfer metadata, Word version/response identity, and upload admission by task capture mode, duration, extension and detected media kind. Policy-gate tests cover refusal before staging, recheck at publication, and staff exemption. The tests use a fake Storage enqueue port and do not contact a cloud destination.

- Increment 04 integration coverage includes slot admission, current owner, actor, phase changes at publication, counted versions, capacity and staff restore; the public API provider checks service scope, page bounds, current ownership, visibility, and its DTO. The worker tests use a synthetic waveform and real local FFmpeg to test conversion, lease loss, audit rollback, idempotent publication, and original retention, and a deliberately missing executable to test degraded health and original availability.
- JS DOM coverage includes mocked microphone permission, cancellation, a local test, keyboard focus, pause/resume, review, object-URL disposal, native capture markup, deep links, and axe checks. Device recording/playback, real browser layout and contrast, and assistive-technology acceptance remain staging checks.

- Storage tests cover opaque-key parsing, rooted storage with private modes, symbolic/hard-link refusal, atomic moves and duplicate-key refusal, streaming limits, hashing, inclusive ranges, and scoped staging cleanup.
- Format tests cover synthetic PDF, WAV, DOCX, streamed WebM, MP4/M4A and Ogg fixtures, malformed or incompatible forms, and canonical typing. Local FFmpeg tests generate and re-encode fragmented MP4/AAC, AAC, MP3 and CAF, and verify task duration from synthetic audio. These are not recordings captured from physical devices.
- Files service tests use MySQL transactions with injected order/session, storage, jobs and audit fakes. They cover staged upload reauthorization, visibility, versions, restore, portable adoption and export in a supplied transaction, earlier source timestamps, retention checks, and upload-rule and download-audit failure paths. The orders module separately tests a late grant revocation under a repeatable-read snapshot.
- Raw HTTP tests exercise the module router with synthetic request state. They cover multipart admission/refusal, attachment safety, single-use tickets and the no-bytes-on-audit-failure path. Production CSRF, session middleware, proxy behavior and rate-limit composition are outside this suite.
- Client tests exercise upload status and partial failure, read-only file access, administrator settings and a targeted accessibility scan in jsdom. They are not browser layout or assistive-technology signoff.

## Operational boundaries

- The local adapter is Linux-specific and requires `/proc/self/fd` access, a private service-account-owned root, and non-writable/untrusted users excluded from its parents and contents. Keep the root outside web-static paths. Files are not application-encrypted; use installation-level filesystem protections appropriate for the data. Local storage is not a supported multi-host replication mechanism.
- The classifier is an allowlist and structural check, not full media decoding, document sanitization, or malware detection. PDF handling is intentionally conservative (classic cross-reference tables; no encrypted or selected active content). The optional external scanner is not configured in production composition.
- Upload visibility is transactional in MySQL; local filesystem and MySQL do not share a distributed transaction. An unresolvable publication commit acknowledgement can leave an object needing operator reconciliation. Retention uses idempotent unlink and durable intent, but deployment-level crash or power-loss recovery was not exercised.
- Browser and assistive-technology acceptance, cross-device layouts, real reverse-proxy limits, deployment health, and full recovery/portable worker runs need integration verification. The portal download does not serve HTTP ranges even though the local adapter supports bounded reads.
