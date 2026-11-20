# ReadyPackets deployment

The supported template here is the Ubuntu 24.04 single-node kit for `my.readypackets.com`. Start with the [installation runbook](../docs/operations/INSTALL.md) and review the [verification gates](VERIFICATION.md). Use `install.sh`, `upgrade.sh`, and `uninstall.sh` for this layout; the two app units require the managed `10-runtime.conf` drop-in.

The Docker draft and separate archive installer are not supported. The native scripts are the single installation workflow. Do not enable the legacy example `nginx/my.readypackets.com.conf` alongside the managed site.

Release promotion (`prepare-release.mjs`) includes `dist/ops/catalog-import.js` and `data/catalog/**` (`readypackets-offerings-v3.0.json` and `offerings.schema.json`) in each published `/opt/readypackets/releases/<commit>` tree while continuing to exclude `seed-demo.js`. `install.sh` intentionally does not import the offerings matrix automatically; run `node dist/ops/catalog-import.js --dry-run` and then `node dist/ops/catalog-import.js` under the `readypackets` systemd runtime environment after migration and first-administrator bootstrap as documented in [INSTALL.md](../docs/operations/INSTALL.md#load-the-offerings-catalog-optional).
