# Deployment contract

| Runtime setting | Default | Contract |
| --- | --- | --- |
| `RP_FFMPEG_PATH` | `/usr/bin/ffmpeg` | Fixed absolute executable path (`config.ffmpegPath`). Native setup and upgrades install FFmpeg and `/usr/bin/prlimit` (`util-linux`); the Docker runtime image includes both. The files module owns the bounded conversion and version probe. Missing tooling disables conversion, not the original upload. |
| `PROTECTION_MMDB_PATH` | Unset | Optional absolute MMDB file (`config.protectionMmdbPath`). Native conventions are `/var/lib/readypackets/geo/country.mmdb`, directory `root:readypackets` mode `0750`, file `root:readypackets` mode `0640`. Installer and upgrade create the directory, never download a database or enable geoblocking. Mount an operator-supplied database read-only on container deployments. |
| `PROTECTION_DISABLED` | `0` | Native/container emergency bypass (`config.protectionDisabled`); `1` bypasses application protection rules, not authentication or authorization. Restore `0` after correcting the rule. |
| `PROTECTION_COUNTRY_HEADER` | Unset | Optional literal `x-readypackets-country` (`config.protectionCountryHeader`). The bundled proxies strip it; a custom trusted direct proxy must overwrite incoming values before supplying it. No proxy country header is trusted by default. |

Native upgrade CI installs Increment 03 at `89c5cb8`, prepares representative live state, and upgrades to the candidate release. It checks `0003`, `0004`, and `0005` by SQL SHA-256 in the MySQL migration journal. Native release promotion and Docker image builds validate the packaged migration bundle before use; both deployment paths apply the reviewed journal rather than running SQL files individually.

The workflow import transport uses two non-batched POST routes under `/api/trpc/orders.admin.workflows.transfer`: `.preview` and `.applyImport`. They allow 4,456,448 bytes of request body. The default 256 KiB body limit and existing unrelated upload exceptions are unchanged in the managed profiles. The application still enforces authentication, batch refusal and the 2 MiB workflow package limit.

The `/api/webhooks/inbound`, `/api/payments/webhooks` and `/api/payments/return` route families are canonical HTTPS only. Native Nginx rejects them without redirects on HTTP or the alias. Docker Caddy rejects them on HTTP and does not serve aliases. Edge request logs omit path and query.
