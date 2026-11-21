# Increment 04 deployment contract

| Runtime setting | Default | Contract |
| --- | --- | --- |
| `RP_FFMPEG_PATH` | `/usr/bin/ffmpeg` | Fixed absolute executable path (`config.ffmpegPath`). Native setup and upgrades install FFmpeg and `/usr/bin/prlimit` (`util-linux`); the Docker runtime image includes both. The files module owns the bounded conversion and version probe. Missing tooling disables conversion, not the original upload. |
| `PROTECTION_MMDB_PATH` | Unset | Optional absolute MMDB file (`config.protectionMmdbPath`). Native conventions are `/var/lib/readypackets/geo/country.mmdb`, directory `root:readypackets` mode `0750`, file `root:readypackets` mode `0640`. Installer and upgrade create the directory, never download a database or enable geoblocking. Mount an operator-supplied database read-only on container deployments. |
| `PROTECTION_DISABLED` | `0` | Native/container emergency bypass (`config.protectionDisabled`); `1` bypasses application protection rules, not authentication or authorization. Restore `0` after correcting the rule. |
| `PROTECTION_COUNTRY_HEADER` | Unset | Lower-case header name (`config.protectionCountryHeader`, 1–63 ASCII letters/digits/hyphens, starts with a letter). Only a configured, trusted direct proxy may supply it and must overwrite incoming values. No proxy header is trusted by default. |

Native upgrade CI installs Increment 03 at `89c5cb8`, prepares representative live state, and upgrades to the candidate release. The release owns no schema files; the integrator owns migration `0003`.

The `/api/webhooks/inbound`, `/api/payments/webhooks` and `/api/payments/return` route families are canonical HTTPS only. Native Nginx rejects them without redirects on HTTP or the alias. Docker Caddy rejects them on HTTP and does not serve aliases. Edge request logs omit path and query.
