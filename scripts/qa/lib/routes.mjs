/* global document -- Used only inside Chromium callback evaluation. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const roles = {
  public: ["anonymous"],
  transition: ["transition"],
  customer: ["customer"],
  staff: ["staff", "admin"],
  admin: ["admin"],
};

export async function qaRouteInventory() {
  const directory = await mkdtemp(join(tmpdir(), "rp-qa-routes-"));
  const output = join(directory, "inventory.json");
  try {
    await run("bash", ["scripts/dev/test.sh", "client/src/test/qaRoutes.test.ts"], {
      cwd: repo, env: { ...process.env, RP_QA_INVENTORY_OUTPUT: output }, timeout: 90_000,
    });
    return JSON.parse(await readFile(output, "utf8"));
  } catch {
    throw new Error("QA could not export ALL_ROUTES. Run scripts/dev/test.sh client/src/test/qaRoutes.test.ts to inspect the registry.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function matchesQaRoute(pattern, path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[\\\r\n]/.test(path)) return false;
  const parsed = new URL(path, "https://qa.invalid");
  if (parsed.origin !== "https://qa.invalid" || parsed.hash) return false;
  const expression = pattern.split("/").map((segment) => segment.startsWith(":") ? "[^/]+" : escapeRegex(segment)).join("/");
  return new RegExp(`^${expression}$`).test(parsed.pathname);
}

export function resolveQaScenarios(inventory, config = {}, directory = process.cwd(), filter = "") {
  const { sessions = {}, cases: overrides = {} } = config;
  const knownIds = new Set(inventory.map(({ id }) => id));
  if (Object.keys(overrides).some((id) => !knownIds.has(id))) throw new Error("QA fixtures contain a case for an unknown route ID.");
  const cases = [];
  const missing = [];
  for (const route of inventory) {
    if (!route.id.includes(filter)) continue;
    const requiredRoles = route.id === "/accessibility" ? ["anonymous", "customer"] : roles[route.access];
    if (!requiredRoles) throw new Error(`Unknown QA route access for ${route.id}.`);
    const explicit = overrides[route.id] ?? [];
    if (!Array.isArray(explicit)) throw new Error(`QA fixtures: ${route.id} cases must be an array.`);
    const input = [...explicit];
    for (const role of requiredRoles) {
      if (input.some((item) => item.role === role)) continue;
      if (route.path.includes("/:") || route.access === "transition") {
        missing.push(`${route.id} [${role}]: supply a seeded fixture and readiness selector.`);
      } else input.push({ role });
    }
    for (const [index, item] of input.entries()) {
      if (![...requiredRoles, ...(route.access === "public" ? ["customer", "staff", "admin"] : [])].includes(item.role)) {
        throw new Error(`QA fixtures: unexpected role for ${route.id}.`);
      }
      const path = item.path ?? route.path;
      const state = item.storageState ?? sessions[item.role];
      const name = `${route.id} [${item.role} #${index + 1}]`;
      if (!matchesQaRoute(route.path, path) || path.includes("/:")) {
        missing.push(`${name}: supply a concrete route path.`);
        continue;
      }
      if (item.role !== "anonymous" && !state) {
        missing.push(`${name}: supply a disposable QA storage-state file.`);
        continue;
      }
      if ((route.path.includes("/:") || route.access === "transition") && !item.ready) {
        missing.push(`${name}: supply a readiness selector that only exists in the expected fixture state.`);
        continue;
      }
      cases.push({
        name, path, role: item.role, title: item.title ?? route.title,
        heading: item.heading, ready: item.ready, tab: route.tab, steps: item.steps ?? [],
        storageState: state && item.role !== "anonymous" ? resolve(directory, state) : undefined,
      });
    }
  }
  if (!cases.length && !missing.length) throw new Error("QA route filter matched no scenarios.");
  return { cases, missing, partial: Boolean(filter) };
}

export async function qaRouteScenarios() {
  const fixturePath = process.env.QA_ROUTE_FIXTURES;
  let config;
  if (fixturePath) {
    try { config = JSON.parse(await readFile(fixturePath, "utf8")); } catch { throw new Error("QA_ROUTE_FIXTURES is unreadable or not valid JSON."); }
  }
  return resolveQaScenarios(await qaRouteInventory(), config, fixturePath ? dirname(resolve(fixturePath)) : process.cwd(), process.env.QA_ROUTE_FILTER);
}

export async function openQaRoute(page, baseUrl, scenario, theme, beforeSteps) {
  const probe = await page.request.get(new URL("/api/trpc/identity.me", baseUrl).href, { timeout: 8_000, maxRedirects: 0 });
  try {
    const { result } = await probe.json();
    const session = result?.data?.json;
    const validSession = scenario.role === "anonymous" ? probe.status() === 401
      : probe.ok() && (scenario.role === "transition" ? session?.state === "remediation" : session?.state === "full" && session.user?.role === scenario.role);
    if (!validSession) throw new Error("Wrong fixture role or session state.");
  } catch {
    throw new Error("The role or session state did not match the QA fixture; verify the QA origin and disposable session.");
  } finally {
    await probe.dispose();
  }
  const expected = new URL(scenario.path, baseUrl);
  const response = await page.goto(expected.href, { waitUntil: "domcontentloaded", timeout: 15_000 });
  const notFoundProbe = expected.pathname === "/__qa_missing_route__";
  if (!response || (!response.ok() && !(notFoundProbe && response.status() === 404))) {
    throw new Error(`The requested QA route returned HTTP ${response?.status() ?? "unknown"}.`);
  }
  const main = page.locator("main, [role=main]");
  const heading = main.locator("h1");
  try {
    await heading.waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForFunction((title) => document.title === title, scenario.title, { timeout: 10_000 });
    await page.waitForFunction((dark) => document.documentElement.classList.contains("dark") === dark, theme === "dark", { timeout: 5_000 });
    if (scenario.heading) {
      await main.getByRole("heading", { level: 1, name: scenario.heading, exact: true }).waitFor({ state: "visible", timeout: 5_000 });
    }
    await beforeSteps?.();
    if (scenario.tab) await page.getByRole("tab", { name: scenario.tab, exact: true }).click({ timeout: 5_000 });
    for (const step of scenario.steps) {
      await page.getByRole(step.role, { name: step.name, exact: true }).press("Enter", { timeout: 5_000 });
    }
    if (scenario.ready) await page.locator(scenario.ready).waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    throw new Error("Expected route title, heading, theme, interactive state, or seeded fixture was not reached.");
  }
  if (page.url() !== expected.href) throw new Error("Navigation redirected away from the intended QA route.");
  if (await page.locator("h1").count() !== 1 || await main.count() !== 1) throw new Error("Expected exactly one h1 and one main landmark.");
}
