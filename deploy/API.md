# Deployment contract

| Runtime setting | Default | Contract |
| --- | --- | --- |
| `RP_FFMPEG_PATH` | `/usr/bin/ffmpeg` | Fixed absolute executable path (`config.ffmpegPath`). Native setup and upgrades install FFmpeg and `/usr/bin/prlimit` (`util-linux`); the Docker runtime image includes both. The files module owns the bounded conversion and version probe. Missing tooling disables conversion, not the original upload. |
| `PROTECTION_MMDB_PATH` | Unset | Optional absolute MMDB file (`config.protectionMmdbPath`). Native conventions are `/var/lib/readypackets/geo/country.mmdb`, directory `root:readypackets` mode `0750`, file `root:readypackets` mode `0640`. Installer and upgrade create the directory, never download a database or enable geoblocking. Mount an operator-supplied database read-only on container deployments. |
| `PROTECTION_DISABLED` | `0` | Native/container emergency bypass (`config.protectionDisabled`); `1` bypasses application protection rules, not authentication or authorization. Restore `0` after correcting the rule. |
| `POLICY_ENFORCEMENT_DISABLED` | `0` | Session policy enforcement break-glass flag, applied at startup to web and worker. It does not disable action-time acceptance, authentication, MFA or authorization. See [break-glass access recovery](../docs/operations/BREAK_GLASS.md). |
| `PROTECTION_COUNTRY_HEADER` | Unset | Optional literal `x-readypackets-country` (`config.protectionCountryHeader`). The bundled proxies strip it; a custom trusted direct proxy must overwrite incoming values before supplying it. No proxy country header is trusted by default. |

Native upgrade CI installs Increment 03 at `89c5cb8` and the pre-0007 Increment 06 release at `f251a10` in separate runs, creates a real admin, customer and order, and upgrades to the candidate release. It checks `0003` through `0007` by SQL SHA-256 in the MySQL migration journal. Native release promotion and Docker image builds validate the packaged migration bundle before use; both apply the reviewed journal rather than running SQL files individually.

The workflow import transport uses two non-batched POST routes under `/api/trpc/orders.admin.workflows.transfer`: `.preview` and `.applyImport`. They allow 4,456,448 bytes of request body; the application still enforces authentication, batch refusal and the 2 MiB workflow package limit. File upload accepts a 256 MiB multipart envelope on the exact order upload route; document editor saves use a 10 MiB + 16 KiB envelope on the exact two-ULID document route. Application limits remain independent. The general limit is 256 KiB.

The public service worker is scoped to `/` and declares `Service-Worker-Allowed: /`. Neither the worker nor the manifest is served with a long freshness lifetime. Proxies preserve upstream `no-cache` and `no-store`; only build-hashed public assets are immutable.

The `/api/webhooks/inbound`, `/api/payments/webhooks` and `/api/payments/return` route families are canonical HTTPS only. Native Nginx rejects them without redirects on HTTP or the alias. Docker Caddy rejects them on HTTP and does not serve aliases. Edge request logs omit path and query.

SAML metadata, start and ACS use exact canonical HTTPS endpoints. The ACS POST is capped at 256 KiB, bypasses neither address controls nor rate limiting, and is never cached. Playback reads preserve the application's range decision and stream the response without proxy buffering or encoding changes. The archive download is a standard CSRF-protected Files POST.
