# syntax=docker/dockerfile:1
# ReadyPackets portal — container image for the Docker Compose stack in this directory.
# Build context is the repository root:  docker build -f deploy/docker/Dockerfile .
# The build recipe mirrors deploy/lib.sh (frozen lockfile, hoisted production tree, no demo seed).
# Base images are pinned by multi-architecture index digest; Dependabot proposes updates.

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
ENV CI=true \
    npm_config_update_notifier=false \
    npm_config_fund=false
WORKDIR /src
# A compiler toolchain is present in the build stage only, for the reviewed native add-on (argon2) on
# platforms without a prebuilt binary. Nothing from this stage except the listed trees reaches the runtime image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN npm install --global "pnpm@$(node -p 'require("./package.json").packageManager.replace(/^pnpm@/, "").split("+")[0]')"
RUN pnpm install --frozen-lockfile --prod=false --config.node-linker=hoisted
COPY . .
RUN pnpm build \
    && pnpm prune --prod --config.node-linker=hoisted \
    && rm -rf node_modules/.bin \
    && rm -f dist/ops/seed-demo.js dist/ops/seed-demo.js.map \
    && test -f dist/server/main.js -a -f dist/public/index.html -a -f dist/ops/migrate.js \
         -a -f dist/ops/create-admin.js -a -f dist/ops/recover-admin.js -a -f dist/ops/catalog-import.js \
         -a -f dist/ops/generate-keys.js \
         -a -f dist/ops/keys-doctor.js -a -f migrations/meta/_journal.json \
         -a -f data/catalog/readypackets-offerings-v3.0.json -a -f data/catalog/offerings.schema.json \
    && chmod -R go-w package.json node_modules dist migrations data/catalog

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS runtime
# openssl is used once by init-secrets.sh. The package managers are removed: nothing is installed at run time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
              /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
    && groupadd --system --gid 10001 readypackets \
    && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --no-create-home \
               --shell /usr/sbin/nologin readypackets \
    && install -d -o 10001 -g 10001 -m 0700 /var/lib/readypackets /var/lib/readypackets/storage \
               /var/lib/readypackets/tmp \
    && install -d -o root -g root -m 0755 /run/readypackets /run/readypackets/secrets /run/readypackets/migrator \
               /secrets /secrets/app /secrets/migrator /secrets/db
WORKDIR /opt/readypackets
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/migrations ./migrations
COPY --from=build /src/data/catalog ./data/catalog
COPY --chmod=0444 deploy/docker/healthcheck.mjs ./healthcheck.mjs
COPY --chmod=0555 deploy/docker/init-secrets.sh /usr/local/bin/rp-init-secrets
ENV NODE_ENV=production \
    RP_MIGRATIONS_DIR=/opt/readypackets/migrations
USER 10001:10001
EXPOSE 5000
CMD ["node", "dist/server/main.js"]
