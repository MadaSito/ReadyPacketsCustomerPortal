import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/**
 * Build modes:
 *   pnpm build           → production bundle (path routing, same-origin API, cookie session)
 *   pnpm build:preview   → sandboxed-iframe demo bundle (hash routing, proxied API, in-memory session)
 * The PWA service worker is added by the UI foundation engineer (static shell only; never authenticated data).
 */
export default defineConfig(({ mode }) => {
  const preview = mode === "preview";
  process.env.VITE_RP_API_BASE = preview ? "__PORT_5000__" : "";
  process.env.VITE_RP_RUNTIME = preview ? "preview" : "standard";
  return {
    root: path.resolve(import.meta.dirname, "client"),
    // Preview is served under an unknown path prefix → relative URLs. Production is served at the origin
    // root with path routing (nested URLs) → absolute URLs.
    base: preview ? "./" : "/",
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@shared": path.resolve(import.meta.dirname, "shared"),
        "@server": path.resolve(import.meta.dirname, "server"),
        "@": path.resolve(import.meta.dirname, "client/src"),
      },
    },
    build: {
      outDir: path.resolve(import.meta.dirname, "dist/public"),
      emptyOutDir: true,
      sourcemap: false,
      target: "es2022",
    },
    server: { port: 5173, strictPort: true, proxy: { "/api": "http://127.0.0.1:5000" } },
  };
});
