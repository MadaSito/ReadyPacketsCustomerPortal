export const offlinePath = "/offline.html";

const FIXED_ASSETS = new Set([offlinePath, "/offline.css", "/favicon.ico", "/manifest.webmanifest"]);
const BUILD_ASSET = /^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/;
const PUBLIC_MEDIA = /^\/(?:brand\/[a-z0-9-]+\.png|fonts\/[a-z0-9-]+\.woff2)$/;

export function publicPrecacheUrl(url: URL, origin: string): boolean {
  return url.origin === origin && !url.username && !url.password && !url.search && !url.hash &&
    (FIXED_ASSETS.has(url.pathname) || BUILD_ASSET.test(url.pathname) || PUBLIC_MEDIA.test(url.pathname));
}

export function offlineNavigation(url: URL, request: Pick<Request, "method" | "mode" | "headers">, origin: string): boolean {
  if (url.origin !== origin || request.method !== "GET" || request.mode !== "navigate" ||
    request.headers.has("range")) return false;
  // Only ordinary HTML routes. Leave binary/resource requests (even in a new tab), API traffic
  // and signed links to the browser network, without substituting a successful HTML response.
  const path = url.pathname;
  return /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(path) &&
    !/^\/(?:api|trpc|assets|brand|fonts|healthz|readyz)(?:\/|$)/i.test(path) &&
    !/(?:^|\/)(?:downloads?|attachments?|exports?)(?:\/|$)/i.test(path) &&
    ![...url.searchParams.keys()].some((key) => /^(?:download|attachment|signature|token|x-amz-.+)$/i.test(key));
}

export function precacheableResponse(response: Response, origin: string): boolean {
  if (response.status !== 200 || response.redirected || !response.url) return false;
  const url = new URL(response.url);
  const type = response.headers.get("content-type") ?? "";
  const control = response.headers.get("cache-control") ?? "";
  if (!publicPrecacheUrl(url, origin) || /\b(?:private|no-store)\b/i.test(control) ||
    /(?:^|,)\s*(?:\*|cookie|authorization)\s*(?:,|$)/i.test(response.headers.get("vary") ?? "") ||
    response.headers.has("content-disposition")) return false;
  if (url.pathname === offlinePath) return /^text\/html(?:;|$)/i.test(type);
  if (url.pathname.endsWith(".css")) return /^text\/css(?:;|$)/i.test(type);
  if (url.pathname.endsWith(".js")) return /^(?:text|application)\/javascript(?:;|$)/i.test(type);
  if (url.pathname.endsWith(".png")) return /^image\/png(?:;|$)/i.test(type);
  if (url.pathname.endsWith(".ico")) return /^image\/(?:x-icon|vnd\.microsoft\.icon)(?:;|$)/i.test(type);
  if (url.pathname.endsWith(".woff2")) return /^font\/woff2(?:;|$)/i.test(type);
  return /^application\/(?:manifest\+json|json)(?:;|$)/i.test(type);
}
