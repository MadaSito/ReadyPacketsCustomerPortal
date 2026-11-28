import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import express, { type Express } from "express";
import { getHttpState } from "./requestState.js";
import { isNavigation } from "./edge.js";

const HASHED_ASSET = /^(?:.+\/)?assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i;
/** Brand artwork carries its package version in the file name (`-v2026101502`); new artwork gets a new name. */
const VERSIONED_BRAND_ASSET = /^brand\/[a-z0-9-]+-v\d{10}\.(?:png|svg|ico)$/;
const NEVER_SPA = /^\/(?:api|assets|brand|fonts|healthz|readyz|\.well-known)(?:\/|$)/i;
const MAIL_TEMPLATE_EDITOR = "/admin/email-templates/";
const DOTTED_MAIL_KEY = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const CUSTOM_MAIL_KEY = /^custom\.[a-z][a-z0-9_]{1,63}$/u;

function permitsSpaPath(path: string, isBuiltinMailKey: (key: string) => boolean): boolean {
  if (path === "/index.html") return true;
  let decoded: string;
  try {
    // Decode for classification only. Express's static file resolution continues to use the original request.
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  if (decoded.split("/").some((segment) => segment.startsWith("."))) return false;
  if (!extname(path) && !extname(decoded)) return true;

  // The exact editor route is the only SPA route with a dotted identifier. Use the mail
  // registry rather than accepting arbitrary template-shaped filenames like auth.png.
  if (!path.startsWith(MAIL_TEMPLATE_EDITOR)) return false;
  const key = decoded.slice(MAIL_TEMPLATE_EDITOR.length);
  return key.length <= 100 && DOTTED_MAIL_KEY.test(key) && (CUSTOM_MAIL_KEY.test(key) || isBuiltinMailKey(key));
}

function realOrFuturePath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || absolute === dirname(absolute)) throw error;
    return resolve(realOrFuturePath(dirname(absolute)), basename(absolute));
  }
}

export function assertSeparateStorage(staticDir: string, storageDir: string): void {
  const web = realOrFuturePath(staticDir);
  const privateRoot = realOrFuturePath(storageDir);
  const contains = (parent: string, child: string) => {
    const remainder = relative(parent, child);
    return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`));
  };
  if (contains(web, privateRoot) || contains(privateRoot, web)) {
    throw new Error("The public web root must not overlap private storage.");
  }
}

export function registerStatic(
  app: Express, staticDir: string, publicPaths: ReadonlySet<string>,
  isBuiltinMailKey: (key: string) => boolean = () => false,
): void {
  const root = resolve(staticDir);
  const serve = express.static(root, {
    cacheControl: false,
    index: false,
    redirect: false,
    dotfiles: "ignore",
    setHeaders(res, file) {
      const relative = file.slice(root.length + 1).split(sep).join("/");
      if (relative === "sw.js") res.setHeader("Service-Worker-Allowed", "/");
      if (res.getHeader("Cache-Control") === "no-store") return;
      // Only build-generated assets are immutable. The service worker, manifest
      // and other fixed filenames must be revalidated.
      if (HASHED_ASSET.test(relative) || VERSIONED_BRAND_ASSET.test(relative)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      else res.setHeader("Cache-Control", "no-cache");
    },
  });

  app.use((req, res, next) => {
    // Only the fixed, public offline document may be served raw. The app shell needs a fresh nonce.
    if (req.path === "/offline.html") return serve(req, res, next);
    let decoded: string;
    try {
      decoded = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    if (/\.html?$/i.test(decoded) || NEVER_SPA.test(req.path) && !/^\/(?:assets|brand|fonts)(?:\/|$)/.test(req.path)) {
      return next();
    }
    return serve(req, res, next);
  });

  app.use(async (req, res, next) => {
    if (NEVER_SPA.test(req.path) || !isNavigation(req) || !permitsSpaPath(req.path, isBuiltinMailKey)) {
      return next();
    }
    let html: string;
    try {
      html = await readFile(resolve(root, "index.html"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return next();
      throw error;
    }
    const { cspNonce, session } = getHttpState(req);
    if (!session && publicPaths.has(req.path)) res.removeHeader("X-Robots-Tag");
    // The standard Vite build already anchors its own assets at the site root.
    html = html.replaceAll("__CSP_NONCE__", cspNonce);
    res.setHeader("Cache-Control", session ? "no-store" : "no-cache");
    res.type("html").send(html);
  });
}
