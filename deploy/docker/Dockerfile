# syntax=docker/dockerfile:1.7
# Multi-stage, non-root, read-only-rootfs-compatible container image for ReadyPackets Customer Portal.
# Supports RP_ROLE=web, RP_ROLE=worker (includes mysql/mysqldump CLI for encrypted logical backups), and migrations.

FROM node:22.14-bookworm-slim AS build
WORKDIR /app

# Enable pinned pnpm version from package.json (`packageManager`)
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json vite.config.ts drizzle.config.ts ./
COPY shared ./shared
COPY client ./client
COPY server ./server
COPY scripts ./scripts
COPY migrations ./migrations

RUN pnpm build && pnpm prune --prod

# -----------------------------------------------------------------------------
FROM node:22.14-bookworm-slim AS runtime
WORKDIR /app

# Install CA certificates, curl for loopback healthchecks, and mysql-client for worker logical backups/restores
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       default-mysql-client \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 --system readypackets \
    && useradd --uid 10001 --gid 10001 --system --home-dir /nonexistent --shell /usr/sbin/nologin readypackets \
    && mkdir -p /var/lib/readypackets/storage /var/lib/readypackets-recovery \
    && chown -R 10001:10001 /var/lib/readypackets /var/lib/readypackets-recovery

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5000 \
    RP_STORAGE_DIR=/var/lib/readypackets/storage \
    RP_RECOVERY_SANDBOX_DIR=/var/lib/readypackets-recovery

COPY --from=build --chown=root:root /app/package.json ./package.json
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --from=build --chown=root:root /app/migrations ./migrations
COPY --from=build --chown=root:root /app/scripts/ops ./scripts/ops
COPY --from=build --chown=root:root /app/server ./server
COPY --from=build --chown=root:root /app/shared ./shared

USER 10001:10001
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["curl", "--fail", "--silent", "http://127.0.0.1:5000/healthz"]

CMD ["node", "dist/server/main.js"]
