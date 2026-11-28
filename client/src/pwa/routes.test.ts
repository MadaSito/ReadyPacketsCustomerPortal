import { describe, expect, it } from "vitest";
import { offlineNavigation, precacheableResponse, publicPrecacheUrl } from "./routes";

const origin = "https://portal.test";
const at = (path: string) => new URL(path, origin);
const navigation = { method: "GET", mode: "navigate", headers: new Headers() } as const;

describe("static-only service worker rules", () => {
  it.each(["/offline.html", "/offline.css", "/assets/index-Bg28_Glm.js", "/brand/icon-192.png", "/manifest.webmanifest"])(
    "allows an exact public asset %s", (path) => expect(publicPrecacheUrl(at(path), origin)).toBe(true),
  );
  it.each(["/", "/index.html", "/orders", "/api", "/api/trpc/files.abc", "/TRPC", "/download/secret",
    "/orders/file.pdf", "/offline.html?token=example", "/assets/index.js", "https://outside.test/offline.html"])(
    "never precaches %s", (path) => expect(publicPrecacheUrl(at(path), origin)).toBe(false),
  );
  it.each(["/", "/sign-in?next=%2Forders", "/orders/COF9", "/orders/new", "/messages", "/support"])(
    "allows a public offline page on navigation network failure at %s",
    (path) => expect(offlineNavigation(at(path), navigation, origin)).toBe(true),
  );
  it.each(["/api", "/API/files/download/abc", "/api/trpc/orders.list", "/trpc", "/trpc/orders",
    "/orders/abc/download", "/orders/abc/attachments", "/orders/a.zip", "/orders/abc?download",
    "/orders/abc?X-Amz-Signature=example", "/%61pi", "/.well-known/assetlinks.json", "https://outside.test/"])(
    "passes through %s without an offline response",
    (path) => expect(offlineNavigation(at(path), navigation, origin)).toBe(false),
  );
  it("passes through non-navigation, mutations and partial-content requests", () => {
    expect(offlineNavigation(at("/orders"), { ...navigation, mode: "cors" }, origin)).toBe(false);
    expect(offlineNavigation(at("/orders"), { ...navigation, method: "POST" }, origin)).toBe(false);
    expect(offlineNavigation(at("/orders"), { ...navigation, headers: new Headers({ range: "bytes=0-10" }) }, origin)).toBe(false);
  });
  it("rejects private, variant, attachment, redirected and non-asset responses", () => {
    const safe = { status: 200, redirected: false, url: at("/offline.html").href,
      headers: new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }) };
    expect(precacheableResponse(safe as Response, origin)).toBe(true);
    expect(precacheableResponse({ ...safe, redirected: true } as Response, origin)).toBe(false);
    expect(precacheableResponse({ ...safe, url: at("/orders").href } as Response, origin)).toBe(false);
    for (const override of [
      { "cache-control": "no-store" }, { "cache-control": "private" }, { vary: "Accept-Encoding, Cookie" },
      { vary: "Authorization" }, { vary: "*" }, { "content-disposition": "attachment" }, { "content-type": "application/json" },
    ] as Record<string, string>[]) {
      const headers = new Headers(safe.headers);
      for (const [key, value] of Object.entries(override)) headers.set(key, value);
      expect(precacheableResponse({ ...safe, headers } as Response, origin)).toBe(false);
    }
  });
  it("increment 09 D3: precaches the versioned brand SVG/PNG/ICO files only with their exact image type", () => {
    for (const path of ["/brand/readypackets-square-light-v2026101502.svg", "/brand/readypackets-utility-favicon-v2026101502.ico",
      "/brand/readypackets-square-light-512-v2026101502.png"]) expect(publicPrecacheUrl(at(path), origin)).toBe(true);
    for (const path of ["/brand/Logo.svg", "/brand/a.svg.html", "/brand/a.svgz", "/brand/sub/a.svg", "/brand/a.svg?x=1"])
      expect(publicPrecacheUrl(at(path), origin)).toBe(false);
    const svg = { status: 200, redirected: false, url: at("/brand/readypackets-square-light-v2026101502.svg").href,
      headers: new Headers({ "content-type": "image/svg+xml", "cache-control": "no-cache" }) };
    expect(precacheableResponse(svg as Response, origin)).toBe(true);
    expect(precacheableResponse({ ...svg, headers: new Headers({ "content-type": "text/html" }) } as Response, origin)).toBe(false);
  });
});
