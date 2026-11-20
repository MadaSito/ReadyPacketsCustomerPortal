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
              filename: "sw.js",
              strategies: "generateSW",
              workbox: {
                globPatterns: ["offline.html", "offline.css", "assets/**/*.{js,css}", "fonts/*.woff2", "brand/*.png", "favicon.ico", "manifest.webmanifest"],
                navigateFallback: null,
                cleanupOutdatedCaches: true,
                clientsClaim: false,
                skipWaiting: false,
                runtimeCaching: [
                  { urlPattern: ({ url }) => url.pathname.startsWith("/api/"), handler: "NetworkOnly" },
                  {
                    urlPattern: ({ request }) => request.mode === "navigate",
                    handler: "NetworkOnly",
                    options: { precacheFallback: { fallbackURL: "offline.html" } },
                  },
                ],
              },
            }),
          ]),
    ],
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
