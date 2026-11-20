import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import express, { type Express } from "express";
import { getHttpState } from "./requestState.js";
import { isNavigation } from "./edge.js";

const HASHED_ASSET = /^(?:.+\/)?assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i;
const NEVER_SPA = /^\/(?:api|assets|brand|fonts|healthz|readyz|\.well-known)(?:\/|$)/i;

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

export function registerStatic(app: Express, staticDir: string, publicPaths: ReadonlySet<string>): void {
  const root = resolve(staticDir);
  const serve = express.static(root, {
    cacheControl: false,
    index: false,
    redirect: false,
    dotfiles: "ignore",
    setHeaders(res, file) {
      if (res.getHeader("Cache-Control") === "no-store") return;
      const relative = file.slice(root.length + 1).split(sep).join("/");
      // Only build-generated assets are immutable. The service worker, manifest
      // and other fixed filenames must be revalidated.
      if (HASHED_ASSET.test(relative)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      else res.setHeader("Cache-Control", "no-cache");
    },
  });

  app.use((req, res, next) => {
    // HTML is rendered only by the shell handler. It cannot be served raw as an asset.
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
    if (NEVER_SPA.test(req.path) || !isNavigation(req) || (req.path !== "/index.html" && extname(req.path))) {
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
