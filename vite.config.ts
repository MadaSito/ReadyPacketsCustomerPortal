import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Build modes:
 *   pnpm build           → production bundle (path routing, same-origin API, cookie session)
 *   pnpm build:preview   → sandboxed-iframe demo bundle (hash routing, proxied API, in-memory session)
 *
 * Service worker (standard builds only): precaches immutable static assets and a static offline page. It never
 * caches the application document (it carries a per-response CSP nonce and runtime configuration) and never
 * caches /api/** or any authenticated response. Navigations are network-only with the offline page as the
 * fallback. Updates are user-driven (no skipWaiting); the app registers the worker itself.
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
    plugins: [
      react(),
      tailwindcss(),
      ...(preview
        ? []
        : [
            VitePWA({
              injectRegister: false,
              registerType: "prompt",
              manifest: false,
              srcDir: "src/pwa",
              filename: "sw.ts",
              strategies: "injectManifest",
              injectManifest: {
                globPatterns: ["offline.html", "offline.css", "assets/**/*.{js,css}", "fonts/*.woff2", "brand/*.{png,svg,ico}", "favicon.ico", "manifest.webmanifest"],
              },
            }),
          ]),
    ],
    resolve: {
      alias: [
        { find: "@shared", replacement: path.resolve(import.meta.dirname, "shared") },
        { find: "@server", replacement: path.resolve(import.meta.dirname, "server") },
        { find: "@", replacement: path.resolve(import.meta.dirname, "client/src") },
        // Radix dialogs pull in react-remove-scroll-bar, which injects a <style> element that our CSP
        // (style-src 'self') refuses. Exact-match alias to a CSSOM-only replacement; the sub-path
        // `react-remove-scroll-bar/constants` is left alone.
        {
          find: /^react-remove-scroll-bar$/,
          replacement: path.resolve(import.meta.dirname, "client/src/ui/vendor/removeScrollBar.ts"),
        },
      ],
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
