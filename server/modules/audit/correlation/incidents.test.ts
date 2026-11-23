/**
 * Security incidents (D7) on real MySQL with the real durable emitter: runner → incidents, merge, floors after
 * close, timeline, self-audit, actions through the Protection / identity ports, authorisation. Synthetic data only
 * (documentation addresses 198.51.100.0/24 and 203.0.113.0/24).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { DomainError } from "../../../core/errors.js";
import { newRequestContext, runWithRequestContext } from "../../../core/requestContext.js";
import type { SessionPrincipal } from "../../../core/types.js";
import type { Services } from "../../../container.js";
import { createTestDeps, fakePrincipal, silentLogger, type TestHarness } from "../../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../../tests/helpers/testDb.js";
import { createAuditEmitter, type DurableAuditEmitter } from "../emitter.js";
import { createAuditModule, type AuditModule } from "../index.js";
import * as auditSchema from "../schema.js";
import { auditEvents, securityIncidentEvents, securityIncidents } from "../schema.js";
import { CORRELATION_SETTING_KEY } from "./incidents.js";
import { DEFAULT_CORRELATION_CONFIG, type CorrelationConfig } from "./rules.js";

async function rejects(p: Promise<unknown>, reason: string): Promise<void> {
  const error = await p.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).reasonCode).toBe(reason);
}

const ACCOUNT = "ab".repeat(32);
const VICTIM_PUBLIC_ID = "01JEVICTIM0000000000000000";

describe("security incidents (real MySQL, real emitter)", () => {
  let t: TestDb;
  let h: TestHarness;
  let emitter: DurableAuditEmitter;
  let mod: AuditModule;
  let admin: SessionPrincipal;
  let staff: SessionPrincipal;
  let determinable = true;
  const bans: { address: string; durationMinutes: number | null; reason: string }[] = [];
  const ended: { userPublicId: string; reasonCode: string }[] = [];

  const failure = (ip: string, opts: { account?: string; user?: string | null } = {}) =>
    runWithRequestContext(newRequestContext("http", { ipAddress: ip }), () =>
      emitter.record({
        category: "security",
        eventName: "auth.login.failed",
        action: "login",
        outcome: "denied",
        severity: "WARN",
        reasonCode: "BAD_CREDENTIALS",
        actor: { role: "anonymous" },
        resource: opts.user === null ? { type: "user" } : { type: "user", publicId: opts.user ?? VICTIM_PUBLIC_ID },
        attributes: { account_ref: opts.account ?? ACCOUNT, step: "password" },
      }),
    );
  const success = (ip: string) =>
    runWithRequestContext(newRequestContext("http", { ipAddress: ip }), () =>
      emitter.record({
        category: "security",
        eventName: "auth.login.succeeded",
        action: "login",
        outcome: "completed",
        actor: { role: "anonymous" },
        resource: { type: "user", publicId: VICTIM_PUBLIC_ID },
        attributes: { account_ref: ACCOUNT, step: "password" },
      }),
    );
  const burst = async (n: number, ip = "198.51.100.7") => {
    for (let i = 0; i < n; i += 1) {
      await failure(ip);
      h.clock.advance(5_000);
    }
  };
  const count = async (name: string) => {
    const [r] = await t.db.select({ n: sql<number>`count(*)` }).from(auditEvents).where(eq(auditEvents.eventName, name));
    return Number(r?.n ?? 0);
  };
  const onlyBruteForce = (): CorrelationConfig => ({
    ...DEFAULT_CORRELATION_CONFIG,
    rules: Object.fromEntries(Object.entries(DEFAULT_CORRELATION_CONFIG.rules).map(([k, v]) => [k, { ...v, enabled: k === "brute_force_account" || k === "success_after_failures" }])) as CorrelationConfig["rules"],
  });

  beforeAll(async () => {
    t = await createTestDb({ schema: auditSchema });
  });
  afterAll(() => t.cleanup());

  beforeEach(async () => {
    const s = auditSchema;
    for (const table of [s.securityIncidentTimeline, s.securityIncidentEvents, s.securityIncidents, s.securityCorrelationState, s.auditEvents]) await t.db.delete(table);
    h = createTestDeps({ db: t.db });
    emitter = createAuditEmitter({ config: h.config, db: t.db, clock: h.clock, logger: silentLogger, crypto: h.deps.crypto });
    admin = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
    staff = fakePrincipal({ role: "staff", stepUpAt: h.clock.now() });
    determinable = true;
    bans.length = 0;
    ended.length = 0;
    const users = new Map([[admin.userId, { id: admin.userId, publicId: admin.userPublicId, role: "admin", status: "active" }]]);
    const identity = {
      getUser: async (id: number) => users.get(id) ?? null,
      getUserByPublicId: async (publicId: string) => [...users.values()].find((u) => u.publicId === publicId) ?? null,
      signInSignals: { accountRefForUser: async () => null },
      centre: {
        endForUser: async (_p: SessionPrincipal, userPublicId: string, reasonCode: string) => {
          ended.push({ userPublicId, reasonCode });
          return { ended: 2 };
        },
      },
    };
    const protection = {
      clientAddressTrust: () => ({ determinable }),
      manualSignInBan: async (_p: SessionPrincipal, input: { address: string; durationMinutes: number | null; reason: string }) => {
        bans.push(input);
        return { publicId: "01JEBAN0000000000000000000", expiresAt: input.durationMinutes === null ? null : new Date(h.clock.now().getTime() + input.durationMinutes * 60_000) };
      },
    };
    (h.deps as { audit: unknown }).audit = emitter;
    (h.services as unknown as Record<string, unknown>).identity = identity as unknown as Services["identity"];
    (h.services as unknown as Record<string, unknown>).protection = protection as unknown as Services["protection"];
    await h.deps.settings.set(CORRELATION_SETTING_KEY, onlyBruteForce());
    mod = createAuditModule(h.deps);
  });

  it("opens one incident for a burst, is idempotent on re-run, and records security.incident.opened", async () => {
    await burst(10);
    const first = await mod.runCorrelation();
    expect(first).toMatchObject({ findings: 1, opened: 1, updated: 0 });
    const again = await mod.runCorrelation();
    expect(again).toMatchObject({ opened: 0, updated: 0 });
    expect(await count("security.incident.opened")).toBe(1);
    const page = await mod.listIncidents(admin, {});
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ ruleKey: "brute_force_account", severity: "high", status: "open", eventCount: 10, hasUser: true, hasAddress: true });
    expect(page.counts.open).toBe(1);
  });

  it("merges new evidence into the open incident, escalates, and keeps a timeline", async () => {
    await burst(10);
    await mod.runCorrelation();
    await burst(20);
    const run = await mod.runCorrelation();
    expect(run).toMatchObject({ opened: 0, updated: 1 });
    const [summary] = (await mod.listIncidents(admin, {})).items;
    expect(summary!.eventCount).toBe(30);
    expect(summary!.severity).toBe("critical");
    const detail = await mod.getIncident(admin, summary!.publicId);
    expect(detail.timeline.map((x) => x.kind)).toEqual(["opened", "events_added", "escalated"]);
    expect(detail.events).toHaveLength(30);
    expect(detail.auditQuery.where).toMatchObject({ kind: "group", terms: [{ field: "resource_public_id", value: VICTIM_PUBLIC_ID }] });
    expect(await count("security.incident.updated")).toBe(1);
  });

  it("flags a successful sign-in after the failures as a separate critical incident", async () => {
    await burst(6);
    await success("198.51.100.7");
    await mod.runCorrelation();
    const rules = (await mod.listIncidents(admin, {})).items.map((i) => i.ruleKey).sort();
    expect(rules).toEqual(["success_after_failures"]);
  });

  it("acknowledge and close use optimistic versions; closing does not re-open from the same evidence", async () => {
    await burst(10);
    await mod.runCorrelation();
    const [s] = (await mod.listIncidents(admin, {})).items;
    await rejects(mod.acknowledgeIncident(admin, { publicId: s!.publicId, expectedVersion: s!.version + 1 }), "INCIDENT_CHANGED");
    const acked = await mod.acknowledgeIncident(admin, { publicId: s!.publicId, expectedVersion: s!.version });
    expect(acked.status).toBe("acknowledged");
    await rejects(mod.acknowledgeIncident(admin, { publicId: s!.publicId, expectedVersion: acked.version }), "INCIDENT_NOT_OPEN");
    h.clock.advance(1000);
    const closed = await mod.closeIncident(admin, { publicId: s!.publicId, expectedVersion: acked.version, reason: "false_positive" });
    expect(closed.status).toBe("closed");
    expect(await count("security.incident.acknowledged")).toBe(1);
    expect(await count("security.incident.closed")).toBe(1);
    expect((await mod.runCorrelation()).opened).toBe(0);
    // Evidence at or before the close time stays closed; ten fresh failures after it open a new incident.
    await burst(9);
    expect((await mod.runCorrelation()).opened).toBe(0);
    h.clock.advance(1000);
    await burst(10);
    expect((await mod.runCorrelation()).opened).toBe(1);
  });

  it("Ban IP resolves the address server-side and calls Protection; it refuses while addresses are undeterminable", async () => {
    await burst(10, "203.0.113.9");
    await mod.runCorrelation();
    const [s] = (await mod.listIncidents(admin, {})).items;
    determinable = false;
    expect((await mod.getIncident(admin, s!.publicId)).actions.banIp).toEqual({ available: false, reason: "ADDRESS_UNDETERMINABLE" });
    await rejects(mod.banIncidentAddress(admin, { publicId: s!.publicId, durationMinutes: 60, reason: "Repeated failures" }), "CLIENT_ADDRESS_UNDETERMINABLE");
    expect(bans).toHaveLength(0);
    determinable = true;
    const ban = await mod.banIncidentAddress(admin, { publicId: s!.publicId, durationMinutes: 60, reason: "Repeated failures" });
    expect(ban.banPublicId).toBe("01JEBAN0000000000000000000");
    expect(bans).toEqual([{ address: "203.0.113.9", durationMinutes: 60, reason: "Repeated failures" }]);
    await rejects(mod.banIncidentAddress(admin, { publicId: s!.publicId, durationMinutes: 61, reason: "x".repeat(10) }), "BAN_DURATION_INVALID");
    await rejects(mod.banIncidentAddress(admin, { publicId: s!.publicId, eventId: "01JE00000000000000000000ZZ", durationMinutes: null, reason: "Repeated failures" }), "INCIDENT_EVENT_NOT_FOUND");
    const detail = await mod.getIncident(admin, s!.publicId);
    expect(detail.timeline.at(-1)).toMatchObject({ kind: "action_ban_ip", byMe: true });
    const action = await t.db.select({ attributes: auditEvents.attributes }).from(auditEvents).where(eq(auditEvents.eventName, "security.incident.action"));
    expect(JSON.stringify(action)).not.toContain("203.0.113.9");
  });

  it("End sessions calls identity's session centre for the incident's user", async () => {
    await burst(10);
    await mod.runCorrelation();
    const [s] = (await mod.listIncidents(admin, {})).items;
    expect(await mod.endIncidentSessions(admin, { publicId: s!.publicId })).toEqual({ ended: 2 });
    expect(ended).toEqual([{ userPublicId: VICTIM_PUBLIC_ID, reasonCode: "SECURITY_INCIDENT" }]);
  });

  it("stores no raw address and no identifier in incidents", async () => {
    await burst(10, "198.51.100.77");
    await mod.runCorrelation();
    const rows = await t.db.select().from(securityIncidents);
    const links = await t.db.select().from(securityIncidentEvents);
    expect(JSON.stringify([rows, links])).not.toContain("198.51.100.77");
  });

  it("authorisation: staff, stale step-up and customers are refused", async () => {
    await burst(10);
    await mod.runCorrelation();
    const [s] = (await mod.listIncidents(admin, {})).items;
    await rejects(mod.listIncidents(staff, {}), "CAPABILITY_NOT_GRANTED");
    await rejects(mod.getIncident(fakePrincipal({ role: "customer" }), s!.publicId), "CAPABILITY_NOT_GRANTED");
    const noStepUp = fakePrincipal({ role: "admin" });
    await rejects(mod.banIncidentAddress(noStepUp, { publicId: s!.publicId, durationMinutes: 60, reason: "Repeated failures" }), "STEP_UP_REQUIRED");
    await rejects(mod.endIncidentSessions(noStepUp, { publicId: s!.publicId }), "STEP_UP_REQUIRED");
    await rejects(mod.updateCorrelationRules(noStepUp, DEFAULT_CORRELATION_CONFIG), "STEP_UP_REQUIRED");
    expect((await mod.getCorrelationRules(noStepUp)).canEdit).toBe(true);
    expect(bans).toHaveLength(0);
  });

  it("rules: strict on write, old stored values still read, disabled engine opens nothing", async () => {
    await rejects(mod.updateCorrelationRules(admin, { ...DEFAULT_CORRELATION_CONFIG, mergeMinutes: 1 }), "CORRELATION_RULES_INVALID");
    await h.deps.settings.set(CORRELATION_SETTING_KEY, { rules: { brute_force_account: { threshold: 3 } } });
    expect((await mod.getCorrelationRules(admin)).config.rules.brute_force_account).toMatchObject({ threshold: 3, windowMinutes: 15, enabled: true });
    await mod.updateCorrelationRules(admin, { ...onlyBruteForce(), enabled: false });
    await burst(10);
    expect(await mod.runCorrelation()).toMatchObject({ opened: 0 });
    expect((await mod.getCorrelationRules(admin)).lastRun.reason).toBe("DISABLED");
  });
});
