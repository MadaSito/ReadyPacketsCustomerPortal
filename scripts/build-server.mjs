// Bundles the server to dist/server/main.js (ESM). Native/large dependencies stay external and are installed
// from the frozen lockfile on the host. No shell strings, no network.
import { build } from "esbuild";

await build({
  entryPoints: ["server/main.ts"],
  outfile: "dist/server/main.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  sourcemap: "linked",
  legalComments: "none",
  logLevel: "info",
});
