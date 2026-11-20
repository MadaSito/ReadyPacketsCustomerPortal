# ReadyPackets deployment

The supported template here is the Ubuntu 24.04 single-node kit for `my.readypackets.com`. Start with the [installation runbook](../docs/operations/INSTALL.md) and review the [verification gates](VERIFICATION.md). Use `install.sh`, `upgrade.sh`, and `uninstall.sh` for this layout; the two app units require the managed `10-runtime.conf` drop-in.

`docker/`, `nginx/my.readypackets.com.conf`, and the separate archive-based tooling in `scripts/ops/install/` are not part of the native installation procedure or its verification. Do not enable the alternate Nginx site concurrently or mix the archive lifecycle scripts with the native credential and release layout.
