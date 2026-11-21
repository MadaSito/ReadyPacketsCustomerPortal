#!/usr/bin/env node
// Captures disposable QA storage states (customer / staff / admin) for a11y-check and responsive-check.
// Signs in through the real local-auth UI (password + TOTP), so it exercises the same path a person uses.
//
// Env (synthetic QA accounts only, never real people):
//   QA_BASE_URL        exact QA origin; must also equal QA_EXPECT_ORIGIN (typo guard before credentials are typed)
//   QA_EXPECT_ORIGIN   the same origin again
//   QA_STATE_DIR       new directory OUTSIDE the git work tree (must not exist; created 0700, files 0600)
//   QA_<ROLE>_EMAIL, QA_<ROLE>_PASSWORD, QA_<ROLE>_TOTP_SECRET (base32) for ROLE in CUSTOMER, STAFF, ADMIN
//   QA_ROLES           optional comma list (default customer,staff,admin)
// Never prints credentials, codes, cookies or raw browser errors.
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { launchQaBrowser } from "./lib/browser.mjs";

const ROLES = ["customer", "staff", "admin"];

function base32(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/[\s=]/g, "").toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("A QA TOTP secret is not valid base32.");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP, SHA-1, 6 digits, 30 s step. */
export function totp(secret, now = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac("sha1", base32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

function config() {
  const expected = process.env.QA_EXPECT_ORIGIN;
  if (!expected || new URL(expected).origin !== new URL(process.env.QA_BASE_URL ?? "").origin) {
    throw new Error("Set QA_EXPECT_ORIGIN to exactly the QA_BASE_URL origin before credentials are entered.");
  }
  const dir = process.env.QA_STATE_DIR;
  if (!dir) throw new Error("Set QA_STATE_DIR to a private directory outside the repository.");
  const out = resolve(dir);
  const roles = (process.env.QA_ROLES ?? ROLES.join(",")).split(",").map((r) => r.trim()).filter(Boolean);
  for (const role of roles) {
    if (!ROLES.includes(role)) throw new Error(`Unknown QA role ${role}.`);
    for (const key of ["EMAIL", "PASSWORD", "TOTP_SECRET"]) {
      if (!process.env[`QA_${role.toUpperCase()}_${key}`]) throw new Error(`Set QA_${role.toUpperCase()}_${key}.`);
    }
  }
  return { out, roles };
}

/** Outside the git work tree (canonical paths, symlinks resolved) and fresh: refuse an existing path. */
async function privateOutputDir(out) {
  const repo = await realpath(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
  const parent = await realpath(dirname(out)).catch(() => { throw new Error("The parent of QA_STATE_DIR must exist."); });
  const target = join(parent, basename(out));
  const rel = relative(repo, target);
  if (rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`))) throw new Error("QA_STATE_DIR must be outside the repository.");
  if (await lstat(target).then(() => true, () => false)) throw new Error("QA_STATE_DIR must not exist yet (no stale or symlinked sessions).");
  await mkdir(target, { mode: 0o700 });
  return target;
}

async function capture(browser, baseUrl, role) {
  const env = (key) => process.env[`QA_${role.toUpperCase()}_${key}`];
  const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
  try {
    await context.route("**/*", (route) => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(new URL("/sign-in", baseUrl).href, { waitUntil: "domcontentloaded", timeout: 15_000 });
    if (new URL(page.url()).origin !== baseUrl) throw new Error("origin changed");
    await page.getByLabel("Email", { exact: true }).fill(env("EMAIL"));
    await page.getByLabel("Password", { exact: true }).fill(env("PASSWORD"));
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const code = page.getByLabel("6-digit code");
    await code.waitFor({ state: "visible", timeout: 15_000 });
    // Avoid a code that expires mid-submit.
    if (30_000 - (Date.now() % 30_000) < 3_000) await page.waitForTimeout(3_500);
    await code.fill(totp(env("TOTP_SECRET")));
    await code.press("Enter");
    await page.waitForURL((url) => !/^\/(sign-in|mfa)/.test(url.pathname), { timeout: 15_000 });
    const probe = await page.request.get(new URL("/api/trpc/identity.me", baseUrl).href, { timeout: 8_000, maxRedirects: 0 });
    const session = (await probe.json())?.result?.data?.json;
    if (session?.state !== "full" || session.user?.role !== role) throw new Error("role mismatch");
    return await context.storageState();
  } finally {
    await context.close();
  }
}

async function main() {
  const { out: requested, roles } = config();
  const out = await privateOutputDir(requested);
  const { browser, baseUrl } = await launchQaBrowser();
  let failed = 0;
  try {
    for (const role of roles) {
      try {
        const state = await capture(browser, baseUrl, role);
        const file = join(out, `${role}.state.json`);
        await writeFile(file, JSON.stringify(state), { mode: 0o600, flag: "wx" });
        console.log(`Captured ${role} session state.`);
      } catch {
        failed++;
        console.error(`FAIL ${role}: sign-in did not reach a full ${role} session (check the synthetic account, MFA secret and QA origin).`);
      }
    }
  } finally {
    await browser.close();
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`QA setup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
