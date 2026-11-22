#!/usr/bin/env node
/* global document, window -- These globals are used inside Chromium page.evaluate. */
import axe from "axe-core";
import { launchQaBrowser } from "./lib/browser.mjs";
import { openQaRoute, qaRouteScenarios, QaRateLimitedError, routeQaContext, withQaRateLimitRetry } from "./lib/routes.mjs";
import { createQaZoomDriver, setLiteralZoom } from "./lib/zoom.mjs";

const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
// Desktop zoom-equivalent CSS viewports, NOT literal browser zoom. See ACCESSIBILITY.md.
const sizes = [
  { factor: 1, label: "desktop baseline", width: 1280, height: 960 },
  { factor: 2, label: "200% reflow equivalent", width: 640, height: 480 },
  { factor: 4, label: "400% reflow equivalent", width: 320, height: 240 },
];

async function scan(page) {
  // Playwright evaluates the checked-in dependency in the page without loading a vendor script or changing CSP.
  await page.evaluate(axe.source);
  return page.evaluate(async (runTags) => {
    const root = document.documentElement;
    const { violations, incomplete } = await window.axe.run(document, {
      runOnly: { type: "tag", values: runTags },
    });
    return {
      lang: Boolean(root.lang.trim()),
      width: root.clientWidth,
      overflow: Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth,
      violations: violations.map(({ id, nodes }) => `${id} (${nodes.length})`),
      incomplete: incomplete.map(({ id }) => id),
    };
  }, tags);
}

async function main() {
  const driver = process.env.QA_LITERAL_ZOOM === "1" ? await createQaZoomDriver() : await launchQaBrowser();
  const { baseUrl } = driver;
  const literalZoom = "openZoomProfile" in driver;
  let runs = 0;
  let failures = 0;
  let rateLimited = 0;
  try {
    const { cases, missing, partial } = await qaRouteScenarios();
    if (partial) console.log("Partial run: QA_ROUTE_FILTER was supplied. Not release-wide accessibility evidence.");
    for (const message of missing) console.error(`NOT CHECKED ${message}`);
    for (const scenario of cases) {
      for (const theme of ["light", "dark"]) {
        for (const { factor, label, width, height } of sizes) {
          const mode = literalZoom ? `${factor * 100}% browser zoom` : label;
          const scope = `${scenario.name} · ${theme} · ${mode} (≤${width} CSS px viewport)`;
          runs++;
          let close;
          try {
            let page;
            await withQaRateLimitRetry(async () => {
              let context;
              let zoom;
              await close?.();
              if (literalZoom) {
                const profile = await driver.openZoomProfile(theme, scenario.storageState);
                ({ context, page, close } = profile);
                zoom = () => setLiteralZoom(page, profile.worker, factor, width);
              } else {
                context = await driver.browser.newContext({
                  colorScheme: theme, viewport: { width, height }, storageState: scenario.storageState,
                  acceptDownloads: false, serviceWorkers: "block",
                });
                close = () => context.close();
                page = await context.newPage();
              }
              // A disposable instance should not contact external analytics, fonts, or services during QA.
              await routeQaContext(context, baseUrl);
              await openQaRoute(page, baseUrl, scenario, theme, zoom);
            }, (line) => console.log(line));
            const result = await scan(page);
            const problems = [...result.violations];
            if (!result.lang) problems.push("missing document language");
            if (result.width > width) problems.push(`viewport did not reflow to ${width} CSS px`);
            if (result.overflow > 1) problems.push(`page horizontal overflow ${result.overflow} CSS px`);
            if (problems.length) {
              failures++;
              console.error(`FAIL ${scope}: ${problems.join("; ")}`);
            } else console.log(`PASS automated checks ${scope}`);
            if (result.incomplete.length) console.log(`  Manual review required: ${result.incomplete.join(", ")}`);
          } catch (error) {
            failures++;
            if (error instanceof QaRateLimitedError) {
              rateLimited++;
              console.error(`FAIL ${scope}: rate limited by the QA instance twice (not a page result; re-run this route).`);
              continue;
            }
            // Playwright diagnostics may include a route's synthetic ID or a reset token. Do not print raw errors.
            console.error(`FAIL ${scope}: browser could not reach or scan the expected state (check QA origin, features and fixture).`);
          } finally {
            await close?.();
          }
        }
      }
    }
    console.log(`Automated a11y: ${runs} executed, ${failures} failed (${rateLimited} rate limited), ${missing.length} missing fixture entries. ${literalZoom ? "Literal zoom verified for passing cases; manual checks still required." : "Literal 200%/400% browser zoom and manual checks are still required."}`);
    if (!runs || failures || missing.length) process.exitCode = 1;
  } finally {
    if (!literalZoom) await driver.browser.close();
  }
}

main().catch((error) => {
  console.error(`QA setup failed: ${error.message}`);
  process.exitCode = 1;
});
