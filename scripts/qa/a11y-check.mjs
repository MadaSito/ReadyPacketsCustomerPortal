#!/usr/bin/env node
/* global document, window -- These globals are used inside Chromium page.evaluate. */
import axe from "axe-core";
import { launchQaBrowser } from "./lib/browser.mjs";
import { openQaRoute, qaRouteScenarios } from "./lib/routes.mjs";

const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
// Desktop zoom-equivalent CSS viewports, NOT literal browser zoom. See ACCESSIBILITY.md.
const sizes = [
  { label: "desktop baseline", width: 1280, height: 960 },
  { label: "200% reflow equivalent", width: 640, height: 480 },
  { label: "400% reflow equivalent", width: 320, height: 240 },
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
  const { browser, baseUrl } = await launchQaBrowser();
  let runs = 0;
  let failures = 0;
  try {
    const { cases, missing, partial } = await qaRouteScenarios();
    if (partial) console.log("Partial run: QA_ROUTE_FILTER was supplied. Not release-wide accessibility evidence.");
    for (const message of missing) console.error(`NOT CHECKED ${message}`);
    for (const scenario of cases) {
      for (const theme of ["light", "dark"]) {
        for (const { label, width, height } of sizes) {
          const scope = `${scenario.name} · ${theme} · ${label} (${width} CSS px viewport)`;
          runs++;
          let context;
          try {
            context = await browser.newContext({
              colorScheme: theme, viewport: { width, height }, storageState: scenario.storageState,
              acceptDownloads: false, serviceWorkers: "block",
            });
            // A disposable instance should not contact external analytics, fonts, or services during QA.
            await context.route("**/*", (route) => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
            const page = await context.newPage();
            await openQaRoute(page, baseUrl, scenario, theme);
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
          } catch {
            failures++;
            // Playwright diagnostics may include a route's synthetic ID or a reset token. Do not print raw errors.
            console.error(`FAIL ${scope}: browser could not reach or scan the expected state (check QA origin, features and fixture).`);
          } finally {
            await context?.close();
          }
        }
      }
    }
    console.log(`Automated a11y: ${runs} executed, ${failures} failed, ${missing.length} missing fixture entries. Literal 200%/400% browser zoom and manual checks are still required.`);
    if (!runs || failures || missing.length) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`QA setup failed: ${error.message}`);
  process.exitCode = 1;
});
