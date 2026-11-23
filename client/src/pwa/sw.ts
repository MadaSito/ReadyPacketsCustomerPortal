/// <reference lib="webworker" />
import { setCacheNameDetails } from "workbox-core";
import { PrecacheController, cleanupOutdatedCaches } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { offlineNavigation, offlinePath, precacheableResponse, publicPrecacheUrl } from "./routes";

declare const self: ServiceWorkerGlobalScope;

const origin = self.location.origin;
// Do not reuse the old credentialed precache. Workbox removes it at activation.
setCacheNameDetails({ precache: "precache-v3" });
const precache = new PrecacheController({
  fallbackToNetwork: false,
  plugins: [{
    // Workbox's install request otherwise sends same-origin cookies.
    requestWillFetch: async ({ request }) => new Request(request, { credentials: "omit", redirect: "error", cache: "reload" }),
    cacheWillUpdate: async ({ response }) => precacheableResponse(response, origin) ? response : null,
  }],
});
precache.precache(self.__WB_MANIFEST.filter((entry) =>
  publicPrecacheUrl(new URL(typeof entry === "string" ? entry : entry.url, self.location.href), origin),
));
// Remove the legacy Workbox caches, including the former credentialed precache.
cleanupOutdatedCaches();

async function readPublicPrecache(url: string) {
  const key = precache.getCacheKeyForURL(url);
  // Unlike caches.open(), this does not recreate a storage bucket after sign-out.
  return key ? caches.match(key, { cacheName: precache.strategy.cacheName }).catch(() => undefined) : undefined;
}

registerRoute(
  ({ url, request }) => publicPrecacheUrl(url, origin) && !request.headers.has("range") &&
    !request.headers.has("authorization") && precache.getCacheKeyForURL(url.href) !== undefined,
  async ({ request }) => (await readPublicPrecache(request.url)) ?? fetch(request),
);
registerRoute(
  ({ url, request }) => offlineNavigation(url, request, origin),
  async ({ request }) => {
    try {
      return await fetch(request);
    } catch {
      const offline = await readPublicPrecache(offlinePath);
      if (offline) return offline;
      // Sign-out wipes all Cache Storage. Keep a public, script-free fallback in the worker
      // itself so clearing the cache never causes us to rehydrate it or lose the offline message.
      return new Response(`<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow"><title>You're offline | ReadyPackets</title>
<main><h1>You're offline</h1><p>ReadyPackets needs an internet connection to show your orders and files.</p>
<p><a href="/">Try again</a></p></main></html>`, {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        },
      });
    }
  },
);

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") event.waitUntil(self.skipWaiting());
});
