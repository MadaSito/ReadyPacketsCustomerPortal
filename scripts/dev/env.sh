# Source this in every shell: `source scripts/dev/env.sh`
# Development sandbox only. Selects the pinned Node.js 22 LTS toolchain and local dev database.
export PATH="/opt/node22/bin:$HOME/.local/share/pnpm:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export RP_DEV_MYSQL_URL="${RP_DEV_MYSQL_URL:-mysql://rp_dev:rp_dev_local_only@127.0.0.1:3306}"
