/* global window -- Used only inside Chromium init script evaluation. */
import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { routeQaContext } from "./routes.mjs";

async function isExecutable(path) {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

export function parseQaBaseUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error("Set QA_BASE_URL to the origin of a disposable QA portal."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("QA_BASE_URL must be an HTTP(S) origin without credentials, a path, query, or fragment.");
  }
  return url.origin;
}

export async function qaChromiumPath(configured = process.env.QA_CHROMIUM_PATH, cache = join(homedir(), ".cache", "ms-playwright")) {
  if (configured) {
    if (!await isExecutable(configured)) throw new Error("QA_CHROMIUM_PATH is not executable. Set it to the local Chromium binary.");
    return configured;
  }
  const available = await readdir(cache).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const builds = available.filter((name) => /^chromium-\d+$/.test(name))
    .sort((left, right) => Number(right.split("-")[1]) - Number(left.split("-")[1]));
  for (const build of builds) {
    for (const directory of ["chrome-linux", "chrome-linux64"]) {
      const path = join(cache, build, directory, "chrome");
      if (await isExecutable(path)) return path;
    }
  }
  throw new Error("No local Chromium executable found. Set QA_CHROMIUM_PATH or install Chromium in the Playwright cache separately. This runner does not download a browser.");
}

export async function launchQaBrowser() {
  const baseUrl = parseQaBaseUrl(process.env.QA_BASE_URL);
  const executablePath = await qaChromiumPath();
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath, headless: true });
  return { browser, baseUrl };
}

/** Fresh pages at every width; optionally retain the browser context only within one scenario/theme/input mode. */
export function createQaPages(browser, baseUrl, reuse) {
  let context;
  let page;
  let key;
  let initialState;
  async function finish(force = false) {
    if (force || !reuse) {
      await context?.close();
      context = page = key = initialState = undefined;
    } else {
      await page?.close();
      page = undefined;
    }
  }
  return {
    finish,
    async open(scenario, theme, viewport, hasTouch = false) {
      const nextKey = JSON.stringify([scenario.name, scenario.path, scenario.storageState, theme, hasTouch]);
      if (key !== nextKey) await finish(true);
      else await finish();
      if (!context) {
        initialState = reuse && scenario.storageState ? JSON.parse(await readFile(scenario.storageState, "utf8")) : undefined;
        context = await browser.newContext({
          colorScheme: theme, viewport, storageState: reuse ? initialState : scenario.storageState, hasTouch,
          acceptDownloads: false, serviceWorkers: "block",
        });
        key = nextKey;
        await routeQaContext(context, baseUrl);
        if (reuse) {
          const entries = initialState?.origins?.find(({ origin }) => origin === baseUrl)?.localStorage ?? [];
          await context.addInitScript(({ origin, entries }) => {
            if (window.location.origin !== origin) return;
            window.localStorage.clear();
            window.sessionStorage.clear();
            for (const { name, value } of entries) window.localStorage.setItem(name, value);
            window.history.scrollRestoration = "manual";
            window.scrollTo(0, 0);
          }, { origin: baseUrl, entries });
        }
      } else {
        await context.clearCookies();
        if (initialState?.cookies?.length) await context.addCookies(initialState.cookies);
      }
      page = await context.newPage();
      if (reuse) {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme: theme });
      }
      return page;
    },
  };
}
