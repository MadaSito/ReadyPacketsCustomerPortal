# ReadyPackets deployment

The supported template here is the Ubuntu 24.04 single-node kit for `my.readypackets.com`. Start with the [installation runbook](../docs/operations/INSTALL.md) and review the [verification gates](VERIFICATION.md). Use `install.sh`, `upgrade.sh`, and `uninstall.sh` for this layout; the two app units require the managed `10-runtime.conf` drop-in.

The Docker draft and separate archive installer are not supported. The native scripts are the single installation workflow. Do not enable the legacy example `nginx/my.readypackets.com.conf` alongside the managed site.
