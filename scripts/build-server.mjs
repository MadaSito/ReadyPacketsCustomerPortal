// Bundles the server to dist/server/main.js and the operator commands to dist/ops/*.js (ESM).
// Third-party packages stay external and are installed from the frozen lockfile on the host
// (`pnpm install --prod --frozen-lockfile`), so operator commands run with plain `node` — no tsx at runtime.
// No shell strings, no network.
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  sourcemap: "linked",
  legalComments: "none",
  logLevel: "info",
};

await build({ ...common, entryPoints: ["server/main.ts"], outfile: "dist/server/main.js" });

await build({
  ...common,
  outdir: "dist/ops",
  entryPoints: {
    migrate: "scripts/ops/migrate.ts",
    "create-admin": "scripts/ops/create-admin.ts",
    "seed-demo": "scripts/ops/seed-demo.ts",
    "catalog-import": "scripts/ops/catalog-import.ts",
    "run-backup": "scripts/ops/backup/run-backup.ts",
    "verify-backup": "scripts/ops/backup/verify-backup.ts",
    "restore-isolated": "scripts/ops/restore/restore-isolated.ts",
    "generate-keys": "scripts/ops/keys/generate.ts",
    "keys-doctor": "scripts/ops/keys/doctor.ts",
  },
});
