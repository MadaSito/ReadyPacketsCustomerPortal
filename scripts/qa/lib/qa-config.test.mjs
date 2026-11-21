import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseQaBaseUrl, qaChromiumPath } from "./browser.mjs";
import { matchesQaRoute, resolveQaScenarios } from "./routes.mjs";
import { setLiteralZoom } from "./zoom.mjs";

test("QA setup accepts only plain HTTP origins", () => {
  assert.equal(parseQaBaseUrl("http://127.0.0.1:9090"), "http://127.0.0.1:9090");
  for (const rejected of ["https://user@example.test", "https://example.test/?secret=1", "file:///tmp", "https://example.test/qa"]) {
    assert.throws(() => parseQaBaseUrl(rejected), /QA_BASE_URL/);
  }
});

test("Chromium resolution selects the newest executable, with no implicit downloads", async () => {
  const cache = await mkdtemp(join(tmpdir(), "rp-browser-test-"));
  try {
    await assert.rejects(qaChromiumPath("", cache), /No local Chromium/);
    for (const [build, directory, mode] of [[9, "chrome-linux", 0o700], [131, "chrome-linux64", 0o700], [149, "chrome-linux", 0o600]]) {
      const folder = join(cache, `chromium-${build}`, directory);
      await mkdir(folder, { recursive: true });
      const binary = join(folder, "chrome");
      await writeFile(binary, "");
      await chmod(binary, mode);
    }
    assert.equal(await qaChromiumPath("", cache), join(cache, "chromium-131", "chrome-linux64", "chrome"));
    await assert.rejects(qaChromiumPath(join(cache, "missing"), cache), /not executable/);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

const inventory = [
  { id: "/accessibility", path: "/accessibility", access: "public", title: "Accessibility" },
  { id: "/orders/:id", path: "/orders/:id", access: "customer", title: "Order" },
  { id: "/mfa", path: "/mfa", access: "transition", title: "MFA" },
];

test("route resolution distinguishes missing authenticated/transition states from a pass", () => {
  const { cases, missing } = resolveQaScenarios(inventory);
  assert.deepEqual(cases.map(({ role }) => role), ["anonymous"]);
  assert.equal(missing.length, 3);
  assert.throws(() => resolveQaScenarios(inventory, { cases: { "/not-a-route": [] } }), /unknown route ID/);
});

test("explicit route fixtures add roles and concrete paths without redirecting to external hosts", () => {
  const result = resolveQaScenarios(inventory, {
    sessions: { customer: "customer.json" },
    cases: {
      "/orders/:id": [{ role: "customer", path: "/orders/example?tab=files", ready: "[data-testid='order-files']" }],
      "/mfa": [{ role: "transition", storageState: "mfa.json", ready: "form" }],
    },
  }, "/tmp/qa");
  assert.equal(result.cases.length, 4);
  assert.deepEqual(result.missing, []);
  assert.equal(result.cases[2].storageState, "/tmp/qa/customer.json");
  for (const rejected of ["//elsewhere.test/orders/id", "/orders/id#different", "/orders/../sign-in", "/\\elsewhere.test/orders/id"]) {
    assert.equal(matchesQaRoute("/orders/:id", rejected), false);
  }
});

test("literal zoom requires browser-reported zoom and waits for the matching DPR and viewport", async () => {
  const worker = { evaluate: async (_fn, zoom) => zoom };
  const page = {
    evaluate: async () => ({ dpr: 1.25, width: 1280 }),
    waitForFunction: async (_fn, args) => { assert.deepEqual(args, { dpr: 5, maxWidth: 320 }); },
  };
  await setLiteralZoom(page, worker, 4, 320);
  await assert.rejects(setLiteralZoom(page, { evaluate: async () => 1 }, 4, 320), /did not report/);
  await assert.rejects(setLiteralZoom({ evaluate: async () => ({ dpr: 1, width: 800 }) }, worker, 4, 320), /desktop zoom baseline/);
});
