#!/usr/bin/env node
/* global document, getComputedStyle, Node -- These globals are used inside Chromium page.evaluate. */
// Responsive QA (increment 04, package N): every registered route × widths × both themes.
// Fails on page-level horizontal overflow, clipped text and visible tap targets smaller than 24×24 CSS px
// (WCAG 2.2 SC 2.5.8 minimum; inline links inside running text are exempt, as the criterion allows).
// Requires QA_BASE_URL (disposable QA origin). Optional: QA_CHROMIUM_PATH, QA_ROUTE_FIXTURES, QA_ROUTE_FILTER,
// QA_WIDTHS (comma list, partial run). Never prints raw Playwright errors (they may include tokens).
import { launchQaBrowser } from "./lib/browser.mjs";
import { openQaRoute, qaRouteScenarios } from "./lib/routes.mjs";

const ALL_WIDTHS = [240, 320, 390, 768, 1024, 1440, 1920, 2560];
const MIN_TARGET = 24;

function widths() {
  const raw = process.env.QA_WIDTHS;
  if (!raw) return { list: ALL_WIDTHS, partial: false };
  const list = raw.split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value >= 200 && value <= 4000);
  if (!list.length) throw new Error("QA_WIDTHS must be a comma-separated list of CSS pixel widths (200–4000).");
  return { list, partial: true };
}

async function measure(page, minTarget) {
  return page.evaluate((min) => {
    const root = document.documentElement;
    const overflow = Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth;
    const describe = (el) => {
      const name = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "").trim().replace(/\s+/g, " ").slice(0, 40);
      const id = el.id ? `#${el.id}` : "";
      return `${el.tagName.toLowerCase()}${id}${name ? ` "${name}"` : ""}`;
    };
    const visible = (el) => {
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    // Clipped text: an element with direct text whose content is wider than its box and which does not handle
    // overflow on purpose (scroll container, or truncation with an accessible full value via title/aria-label).
    const clipped = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (clipped.length >= 10) break;
      if (!visible(el) || el.closest("[aria-hidden=true], .sr-only, svg, pre, code, table")) continue;
      const hasText = [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      if (!hasText || el.scrollWidth - el.clientWidth <= 1 || el.clientWidth === 0) continue;
      const style = getComputedStyle(el);
      const scrolls = ["auto", "scroll"].includes(style.overflowX);
      const truncatesAccessibly = style.textOverflow === "ellipsis" && (el.title || el.getAttribute("aria-label") || el.closest("[title], [aria-label]"));
      if (scrolls || truncatesAccessibly) continue;
      if (style.overflowX === "visible" && el.getBoundingClientRect().right <= root.clientWidth + 1) continue;
      clipped.push(describe(el));
    }
    // Tap targets: visible interactive controls below the minimum, except inline links in a sentence.
    const small = [];
    const selector = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=radio], [role=checkbox], [role=switch], [role=menuitem], [tabindex]:not([tabindex='-1'])";
    for (const el of document.querySelectorAll(selector)) {
      if (small.length >= 10) break;
      if (!visible(el) || el.closest("[aria-hidden=true], [inert]") || el.disabled) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width >= min && rect.height >= min) continue;
      const inline = el.tagName === "A" && getComputedStyle(el).display === "inline" && el.parentElement && [...el.parentElement.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      if (inline) continue;
      // Spacing exception (2.5.8): a 24px circle centred on the target must not intersect another target.
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const crowded = [...document.querySelectorAll(selector)].some((other) => {
        if (other === el || other.contains(el) || el.contains(other) || !visible(other)) return false;
        const o = other.getBoundingClientRect();
        const dx = Math.max(o.left - cx, 0, cx - o.right);
        const dy = Math.max(o.top - cy, 0, cy - o.bottom);
        return Math.hypot(dx, dy) < min / 2;
      });
      if (crowded) small.push(`${describe(el)} ${Math.round(rect.width)}×${Math.round(rect.height)}`);
    }
    return { width: root.clientWidth, overflow, clipped, small, dark: root.classList.contains("dark") };
  }, minTarget);
}

async function main() {
  const { list, partial: partialWidths } = widths();
  const { browser, baseUrl } = await launchQaBrowser();
  let runs = 0;
  let failures = 0;
  try {
    const { cases, missing, partial } = await qaRouteScenarios();
    if (partial || partialWidths) console.log("Partial run: QA_ROUTE_FILTER or QA_WIDTHS was supplied. Not release-wide responsive evidence.");
    for (const message of missing) console.error(`NOT CHECKED ${message}`);
    for (const scenario of cases) {
      for (const theme of ["light", "dark"]) {
        for (const width of list) {
          const height = width < 768 ? 800 : 900;
          const scope = `${scenario.name} · ${theme} · ${width}px`;
          runs++;
          const context = await browser.newContext({
            colorScheme: theme, viewport: { width, height }, storageState: scenario.storageState,
            acceptDownloads: false, serviceWorkers: "block", hasTouch: width < 1024, isMobile: false,
          });
          try {
            await context.route("**/*", (route) => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
            const page = await context.newPage();
            await openQaRoute(page, baseUrl, scenario, theme);
            const result = await measure(page, MIN_TARGET);
            const problems = [];
            if (result.width > width) problems.push(`viewport did not reflow to ${width}px`);
            if (result.overflow > 1) problems.push(`horizontal overflow ${result.overflow}px`);
            if (result.clipped.length) problems.push(`clipped text: ${result.clipped.join(", ")}`);
            if (result.small.length) problems.push(`tap targets < ${MIN_TARGET}px: ${result.small.join(", ")}`);
            if (problems.length) {
              failures++;
              console.error(`FAIL ${scope}: ${problems.join("; ")}`);
            } else console.log(`PASS ${scope}`);
          } catch {
            failures++;
            console.error(`FAIL ${scope}: browser could not reach or measure the expected state (check QA origin, features and fixture).`);
          } finally {
            await context.close();
          }
        }
      }
    }
    console.log(`Responsive check: ${runs} executed, ${failures} failed, ${missing.length} missing fixture entries. Widths: ${list.join(", ")}.`);
    if (!runs || failures || missing.length) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`QA setup failed: ${error.message}`);
  process.exitCode = 1;
});
