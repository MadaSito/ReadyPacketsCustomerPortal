/* global chrome, window -- Used only in Chromium service-worker/page evaluation. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseQaBaseUrl, qaChromiumPath } from "./browser.mjs";

const extensionPath = fileURLToPath(new URL("./zoom-extension", import.meta.url));
const isZoomWorker = (worker) => worker.url().startsWith("chrome-extension://") && worker.url().endsWith("/background.js");

export async function createQaZoomDriver() {
  const baseUrl = parseQaBaseUrl(process.env.QA_BASE_URL);
  const executablePath = await qaChromiumPath();
  const { chromium } = await import("playwright-core");

  async function openZoomProfile(theme, statePath) {
    const userDataDir = await mkdtemp(join(tmpdir(), "rp-qa-zoom-"));
    let context;
    const close = async () => {
      try { await context?.close(); } finally { await rm(userDataDir, { force: true, recursive: true }); }
    };
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        executablePath,
        channel: "chromium",
        headless: true,
        viewport: null, // Do not apply Playwright's synthetic device metrics to literal desktop zoom.
        colorScheme: theme,
        acceptDownloads: false,
        serviceWorkers: "block",
        ignoreDefaultArgs: ["--disable-extensions"],
        args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--window-size=1280,960"],
      });
      if (statePath) {
        const state = JSON.parse(await readFile(statePath, "utf8"));
        const host = new URL(baseUrl).hostname;
        await context.addCookies(state.cookies.filter(({ domain }) => domain.replace(/^\./, "") === host));
        const entries = state.origins.find(({ origin }) => origin === baseUrl)?.localStorage ?? [];
        if (entries.length) {
          await context.addInitScript(({ qaOrigin, entries }) => {
            if (window.location.origin === qaOrigin) {
              for (const { name, value } of entries) window.localStorage.setItem(name, value);
            }
          }, { qaOrigin: baseUrl, entries });
        }
      }
      const worker = context.serviceWorkers().find(isZoomWorker) ??
        await context.waitForEvent("serviceworker", { predicate: isZoomWorker, timeout: 8_000 });
      const page = context.pages()[0] ?? await context.newPage();
      await page.bringToFront();
      return { context, page, worker, close };
    } catch {
      await close();
      throw new Error("Literal zoom requires Chromium that permits a local test extension in headless mode.");
    }
  }

  return { baseUrl, openZoomProfile };
}

/** Change the browser tab's native desktop zoom, not CSS zoom, pinch zoom, or the viewport alone. */
export async function setLiteralZoom(page, worker, factor, maxWidth) {
  const baseline = await page.evaluate(() => ({ dpr: window.devicePixelRatio, width: window.innerWidth }));
  if (baseline.width < 1260 || baseline.width > 1280) throw new Error("Could not establish the 1280 px desktop zoom baseline.");
  const applied = await worker.evaluate(async (zoom) => {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs.length !== 1 || tabs[0].id === undefined) throw new Error("No unique active Chromium QA tab.");
    const tabId = tabs[0].id;
    await chrome.tabs.setZoomSettings(tabId, { mode: "automatic", scope: "per-tab" });
    await chrome.tabs.setZoom(tabId, zoom);
    return chrome.tabs.getZoom(tabId);
  }, factor);
  if (Math.abs(applied - factor) > 0.005) throw new Error("Chromium did not report the requested browser zoom.");
  await page.waitForFunction(({ dpr, maxWidth }) => (
    Math.abs(window.devicePixelRatio - dpr) <= 0.05 &&
    window.visualViewport?.scale === 1 &&
    window.innerWidth <= maxWidth
  ), { dpr: baseline.dpr * factor, maxWidth }, { timeout: 5_000 });
}
