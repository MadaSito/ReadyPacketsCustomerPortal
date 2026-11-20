/**
 * Assembled-system harness for the integration journeys (owner: identity_engineer).
 *
 * Real composition root (createContainer), real MySQL test database, real createApp driven by Supertest,
 * cookie transport + CSRF exactly as a browser sends them. The only substitutions are a FakeClock (TOTP
 * codes, step-up freshness and replay windows must be deterministic) and a temporary storage directory.
 * Mail is read the way an operator would: development mail capture is enabled, the durable job queue is
 * drained, and captured messages are opened through the mail engine (which audits the view).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import request from "supertest";
import type { Response } from "supertest";
import { testConfig, type AppConfig } from "../../server/config/env.js";
import { createContainer, type Container } from "../../server/container.js";
import { FakeClock } from "../../server/core/clock.js";
import { createApp } from "../../server/http/app.js";
import { auditEvents } from "../../server/modules/audit/schema.js";
import { MAIL_CAPTURE, mailEngineFor } from "../../server/modules/jobs/mail.js";
import { engineFor } from "../../server/modules/jobs/queue.js";
import { mailOutbox } from "../../server/modules/jobs/schema.js";
import { totp } from "../../server/modules/assurance/store.js";
import { HEADER_CSRF } from "../../shared/sessionTransportHeaders.js";
import { createTestDb, type TestDb } from "../helpers/testDb.js";

export const HOST = "my.readypackets.test";
export const ORIGIN = `https://${HOST}`;
export const STRONG_PASSWORD = "correct horse battery staple 42";
export const NEW_PASSWORD = "a different long passphrase 2026";

export interface System {
  t: TestDb;
  config: AppConfig;
  clock: FakeClock;
  container: Container;
  app: ReturnType<typeof createApp>;
  http: ReturnType<typeof request>;
  browser(options?: BrowserOptions): Browser;
  /** Runs every due job (mail delivery, password-reset dispatch, …) until the queue is idle. */
  drainJobs(): Promise<number>;
  /** Drains jobs, then opens every newly captured message addressed to `to`. */
  inbox(to: string): Promise<{ subject: string; text: string }[]>;
  audit(filter: { requestId?: string; eventName?: string | string[] }): Promise<(typeof auditEvents.$inferSelect)[]>;
  close(): Promise<void>;
}

let probeAddress = 0;
/** A fresh documentation-range client address (RFC 5737 TEST-NET-3) for a single probe request. */
export function freshProbeAddress(): string {
  probeAddress += 1;
  return `203.0.113.${probeAddress % 250 + 1}`;
}

export interface BrowserOptions {
  host?: string;
  origin?: string | null;
  /** Sec-Fetch-Site; null omits the header. */
  fetchSite?: string | null;
  /** Client address presented through the trusted proxy (each browser defaults to its own). */
  address?: string;
}

export async function createSystem(overrides: Partial<AppConfig> = {}): Promise<System> {
  const t = await createTestDb();
  const storageDir = await mkdtemp(join(tmpdir(), "rp-integration-"));
  // Supertest connects from loopback; treating it as the trusted reverse proxy lets each simulated browser
  // present its own client address (X-Forwarded-For), as it would behind the production proxy.
  const config = testConfig({ databaseUrl: t.url, storageDir, trustedProxies: ["127.0.0.1/32", "::1/128", "::ffff:127.0.0.1/128"], ...overrides });
  const clock = new FakeClock(new Date("2026-11-20T09:00:00.000Z"));
  const container = createContainer(config, { db: t.db, clock });
  const { services } = container;
  await services.settings.set(MAIL_CAPTURE.key, true);
  // One synthetic client address drives every journey; the limiter itself is covered by tests/http.
  for (const category of ["auth_high_risk", "user_login", "form_submission", "api", "expensive", "standard_browsing"]) {
    await services.settings.set(`http.rate_limit.${category}`, { maxRequests: 100_000, windowSeconds: 60 });
  }
  const app = createApp(services);
  const http = request(app);
  const engine = engineFor(services.jobs)!;
  const mail = mailEngineFor(services.mailer)!;
  const opened = new Set<string>();
  let browsers = 0;

  async function drainJobs(): Promise<number> {
    let ran = 0;
    for (let guard = 0; guard < 200; guard += 1) {
      const claim = await engine.claim();
      if (!claim) return ran;
      await engine.execute(claim);
      ran += 1;
    }
    throw new Error("job queue did not become idle");
  }

  return {
    t, config, clock, container, app, http,
    browser: (options) => new Browser(http, config, clock, { address: `198.51.100.${(browsers += 1) % 250 + 1}`, ...options }),
    drainJobs,
    async inbox(to) {
      await drainJobs();
      const rows = await t.db.select({ publicId: mailOutbox.publicId }).from(mailOutbox)
        .where(eq(mailOutbox.state, "captured")).orderBy(mailOutbox.id);
      const messages: { subject: string; text: string }[] = [];
      for (const row of rows) {
        if (opened.has(row.publicId)) continue;
        const message = await t.db.transaction((tx) => mail.viewCapture(tx, row.publicId));
        if (message.to !== to) continue;
        opened.add(row.publicId);
        messages.push({ subject: message.subject, text: message.text });
      }
      return messages;
    },
    async audit(filter) {
      const names = filter.eventName === undefined ? undefined : [filter.eventName].flat();
      return t.db.select().from(auditEvents).where(and(
        filter.requestId ? eq(auditEvents.requestId, filter.requestId) : undefined,
        names ? inArray(auditEvents.eventName, names) : undefined,
      )).orderBy(auditEvents.id);
    },
    async close() {
      await container.close();
      await t.cleanup();
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}

export interface CookieRecord {
  value: string;
  attributes: string[];
}

export interface TrpcResult<T = unknown> {
  res: Response;
  status: number;
  requestId: string;
  data: T;
  error: { code: string; httpStatus: number; safe: { domainCode: string; reasonCode: string; requestId: string } } | undefined;
}

/** A browser on the canonical origin: one cookie jar, same-origin fetch metadata, double-submit CSRF. */
export class Browser {
  readonly jar = new Map<string, CookieRecord>();
  /** Every Set-Cookie line received, for attribute assertions. */
  readonly setCookies: string[] = [];

  private sent = 0;

  constructor(
    private readonly http: ReturnType<typeof request>, private readonly config: AppConfig, private readonly clock: FakeClock,
    private readonly options: BrowserOptions = {},
  ) {}

  private decorate<T extends request.Test>(pending: T, extra: { csrf?: string | null; address?: string } = {}): T {
    // The process-local edge pre-gate admits 120 requests per address per 10 s; long sweeps pace themselves
    // on the fake clock instead of tripping it (the gate is covered by tests/http).
    if ((this.sent += 1) % 100 === 0) this.clock.advance(10_001);
    pending.set("Host", this.options.host ?? HOST);
    // Denial audit notes are de-duplicated per address per minute (edgeAdmission.shouldNote), so probes that
    // must each leave a note may present their own address.
    const address = extra.address ?? this.options.address;
    if (address) pending.set("X-Forwarded-For", address);
    const origin = this.options.origin === undefined ? ORIGIN : this.options.origin;
    if (origin !== null) pending.set("Origin", origin);
    const site = this.options.fetchSite === undefined ? "same-origin" : this.options.fetchSite;
    if (site !== null) pending.set("Sec-Fetch-Site", site);
    const cookie = [...this.jar].map(([name, record]) => `${name}=${encodeURIComponent(record.value)}`).join("; ");
    if (cookie) pending.set("Cookie", cookie);
    const csrf = extra.csrf === undefined ? this.csrfToken : extra.csrf;
    if (csrf) pending.set(HEADER_CSRF, csrf);
    return pending;
  }

  absorb(res: Response): Response {
    const lines = (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];
    for (const line of lines) {
      this.setCookies.push(line);
      const [pair, ...attributes] = line.split(";").map((part) => part.trim());
      const at = pair!.indexOf("=");
      const name = pair!.slice(0, at);
      const value = decodeURIComponent(pair!.slice(at + 1));
      const expires = attributes.find((a) => a.toLowerCase().startsWith("expires="));
      const expired = value === "" || (expires !== undefined && Date.parse(expires.slice(8)) <= Date.parse("2026-11-20T00:00:00Z"));
      if (expired) this.jar.delete(name);
      else this.jar.set(name, { value, attributes });
    }
    return res;
  }

  get sessionToken(): string | undefined {
    return this.jar.get(this.config.sessionCookieName)?.value;
  }

  get csrfToken(): string | undefined {
    return this.jar.get(this.config.csrfCookieName)?.value;
  }

  /** What the SPA does on boot: obtain the CSRF cookie. */
  async primeCsrf(): Promise<Response> {
    return this.absorb(await this.decorate(this.http.get("/api/csrf")));
  }

  async query<T = unknown>(path: string, input?: unknown): Promise<TrpcResult<T>> {
    const search = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
    return this.result<T>(await this.decorate(this.http.get(`/api/trpc/${path}${search}`)));
  }

  async mutate<T = unknown>(path: string, input?: unknown, extra: { csrf?: string | null; address?: string } = {}): Promise<TrpcResult<T>> {
    if (!this.csrfToken && extra.csrf === undefined) await this.primeCsrf();
    const body = input === undefined ? {} : { json: input };
    return this.result<T>(await this.decorate(this.http.post(`/api/trpc/${path}`).send(body), extra));
  }

  /** Raw request with the browser's headers (module HTTP routes, uploads, downloads). */
  raw(method: "get" | "post", path: string, extra: { csrf?: string | null; address?: string } = {}): request.Test {
    return this.decorate(this.http[method](path), extra);
  }

  private result<T>(res: Response): TrpcResult<T> {
    this.absorb(res);
    const error = res.body?.error?.json?.data ?? (res.body?.safe ? { code: "EDGE", httpStatus: res.status, safe: res.body.safe } : undefined);
    return { res, status: res.status, requestId: String(res.headers["x-request-id"]), data: res.body?.result?.data?.json as T, error };
  }

  /** Throws with the safe error when a call fails, so journeys read linearly. */
  static ok<T>(result: TrpcResult<T>): T {
    if (result.status !== 200 || result.error) {
      throw new Error(`expected success, got ${result.status} ${JSON.stringify(result.error?.safe ?? result.res.body)}`);
    }
    return result.data;
  }
}

export const totpCode = (secret: string, clock: FakeClock): string => totp(secret).generate({ timestamp: clock.now().getTime() });

/** Extracts the single-use token from a captured mail's link. */
export function linkToken(text: string): string {
  const match = /[?&#]token=([A-Za-z0-9_-]+)/.exec(text) ?? /\/([A-Za-z0-9_-]{32,})(?:\s|$)/.exec(text);
  if (!match) throw new Error("no token link in message");
  return match[1]!;
}

/** Moves the clock past the current 30-second TOTP step so the next code is not a replay. */
export function nextTotpStep(clock: FakeClock): void {
  clock.advance(31_000);
}

/** Remediation enroll_mfa → acknowledge_recovery_codes → full, through the public procedures. */
export async function enrolTotp(sys: System, browser: Browser): Promise<{ secret: string; recoveryCodes: string[]; requestIds: string[] }> {
  const begin = await browser.mutate<{ secret: string; otpauthUri: string }>("assurance.beginTotpEnrollment");
  const { secret } = Browser.ok(begin);
  const confirm = await browser.mutate<{ recoveryCodes: string[]; recoverySetId: string }>("assurance.confirmTotpEnrollment", { code: totpCode(secret, sys.clock) });
  const { recoveryCodes, recoverySetId } = Browser.ok(confirm);
  const ack = await browser.mutate("assurance.acknowledgeRecoveryCodes", { recoverySetId });
  Browser.ok(ack);
  return { secret, recoveryCodes, requestIds: [begin.requestId, confirm.requestId, ack.requestId] };
}

export async function stepUp(sys: System, browser: Browser, password: string, secret: string): Promise<TrpcResult> {
  nextTotpStep(sys.clock);
  return browser.mutate("assurance.stepUp", { password, factor: { method: "totp", code: totpCode(secret, sys.clock) } });
}

export interface ReadyAdmin {
  browser: Browser;
  publicId: string;
  email: string;
  password: string;
  secret: string;
}

/** Bootstrap the first administrator (ops-script path), then complete forced password change + MFA in the browser. */
export async function bootstrapAdmin(sys: System, email = "admin@example.test"): Promise<ReadyAdmin> {
  const created = await sys.t.db.transaction((tx) => sys.container.services.identity.provisionLocalAccount(
    { email, name: "Ada Admin", role: "admin", password: STRONG_PASSWORD, mustChangePassword: true },
    { tx, reason: "bootstrap_admin" },
  ));
  const browser = sys.browser();
  Browser.ok(await browser.mutate("identity.signIn", { email, password: STRONG_PASSWORD }));
  const steps: string[] = [];
  let secret = "";
  for (let guard = 0; guard < 6; guard += 1) {
    const me = Browser.ok(await browser.query<{ nextStep: string | null }>("identity.me"));
    if (!me.nextStep) break;
    steps.push(me.nextStep);
    if (me.nextStep === "change_password") {
      Browser.ok(await browser.mutate("identity.changePassword", { currentPassword: STRONG_PASSWORD, newPassword: NEW_PASSWORD }));
    } else if (me.nextStep === "enroll_mfa") {
      secret = (await enrolTotp(sys, browser)).secret;
    } else {
      throw new Error(`unexpected admin step ${me.nextStep}`);
    }
  }
  return { browser, publicId: created.publicId, email, password: NEW_PASSWORD, secret };
}

/** Admin-created synthetic catalog product (catalog ships empty by design). */
export async function seedProduct(admin: ReadyAdmin): Promise<string> {
  const group = Browser.ok(await admin.browser.mutate<{ publicId: string }>("orders.admin.catalog.createGroup", {
    name: "Integration Catalog (synthetic)", description: "Synthetic test data.", sortOrder: 0, active: true,
  }));
  const product = Browser.ok(await admin.browser.mutate<{ publicId: string }>("orders.admin.catalog.createProduct", {
    groupId: group.publicId, productKey: "integration-item", sortOrder: 0, active: true,
    name: "Integration Item", description: "Synthetic item.", features: ["Synthetic"], priceMinor: 1500, currency: "USD",
  }));
  return product.publicId;
}

export interface ReadyCustomer {
  browser: Browser;
  email: string;
  secret: string;
}

/** Self-registration through verification mail, sign-in and MFA enrolment. */
export async function registerCustomer(sys: System, email: string, name = "Casey Customer"): Promise<ReadyCustomer> {
  const browser = sys.browser();
  Browser.ok(await browser.mutate("identity.register", { email, name, password: STRONG_PASSWORD }));
  const [mail] = await sys.inbox(email);
  if (!mail) throw new Error("no verification mail captured");
  Browser.ok(await browser.mutate("identity.verifyEmail", { token: linkToken(mail.text) }));
  Browser.ok(await browser.mutate("identity.signIn", { email, password: STRONG_PASSWORD }));
  const { secret } = await enrolTotp(sys, browser);
  return { browser, email, secret };
}
