# Media and country database setup

These settings are optional and separate from application features. The full environment template is [server/config/env.example](../../server/config/env.example). On a native install, edit `/etc/readypackets/portal.env` as root, keep ownership `root:root` and permissions `0600`, and restart the applicable service during a maintenance window.

## FFmpeg

Native installation and upgrades install packaged FFmpeg and `prlimit` (`util-linux`); the Docker runtime includes both. Keep the packages patched. When using a custom `RP_FFMPEG_PATH`, use an absolute path to a root-managed executable outside any upload or build-user directory. The default is `/usr/bin/ffmpeg`.

Audio conversion is off by default. If enabled, check the internal System health audio probe for availability and version. Missing or failing tooling must not block original uploads, but derivatives will not be produced. Retain original files under the normal retention policy.

## Optional local country database

No release bundles or fetches a geolocation database. The runtime can read an operator-provided country MMDB locally without a network lookup. Geolocation is approximate, and an unknown country is not proof of a user's location or identity.

1. Obtain the binary `GeoLite2 Country` (`.mmdb`, not CSV or the web service) from [MaxMind GeoLite](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data//). A MaxMind account is required; an authenticated downloader uses a license key. Review the provider's usage and attribution terms, keep key material out of the application environment and repository, and delete outdated copies within the period required by the provider.
2. Download outside the portal, verify the download as directed by the provider, then extract the MMDB. On native installs, stage it within the existing `root:readypackets` `0750` GeoIP directory and rename it into place:

   ```bash
   geo=/var/lib/readypackets/geo
   staged=$(sudo mktemp "$geo/.country.mmdb.XXXXXXXX")
   sudo install -o root -g readypackets -m 0640 /path/to/GeoLite2-Country.mmdb "$staged" &&
     sudo mv -fT -- "$staged" "$geo/country.mmdb"
   ```

   If staging fails, stop before the rename and remove the temporary file. Keep the file outside web roots, application storage, and writable volumes. For containers, see [the Docker setup](../../deploy/docker/README.md#optional-country-database).
3. In `/etc/readypackets/portal.env`, set `PROTECTION_MMDB_PATH=/var/lib/readypackets/geo/country.mmdb`. Restart `readypackets-portal.service` when installing or rotating the database. Leave Protection in detect while independently validating results and checking for unexpected matches before enforcing country policy.

Leave `PROTECTION_COUNTRY_HEADER` unset with bundled Nginx and Caddy profiles, which strip incoming `X-ReadyPackets-Country`. With a custom proxy, the only accepted setting is `PROTECTION_COUNTRY_HEADER=x-readypackets-country`. Only set it after the portal's explicitly trusted direct proxy discards every client-supplied value of that header and inserts its own independently derived country code. `RP_TRUSTED_PROXIES` alone does not make a client-supplied header safe, and an outer CDN does not replace this direct-peer requirement.

If a Protection rule causes a lockout, an authorized operator with host access can set `PROTECTION_DISABLED=1` and restart the web service (or recreate the web container with the override). This bypasses new application Protection rules and restores the original rate limits; it does not bypass authentication, authorization, or network controls. Correct the policy, restore `0` or unset the override, restart again, and document the incident.
