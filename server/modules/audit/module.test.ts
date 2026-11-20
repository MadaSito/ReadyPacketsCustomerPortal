/**
 * Audit center service tests on real MySQL with the REAL durable emitter (self-auditing is observable).
 * Synthetic identities only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Readable } from "node:stream";
import { DomainError } from "../../core/errors.js";
import type { AuditCategory, SessionPrincipal } from "../../core/types.js";
import type { Services } from "../../container.js";
import { createTestDeps, fakePrincipal, silentLogger, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { ChainKeyMismatchError, createChainService } from "./chain.js";
import { createAuditEmitter, type DurableAuditEmitter } from "./emitter.js";
import { createAuditModule, type AuditModule } from "./index.js";
import { auditQuerySchema, compileQuery, MAX_DEPTH } from "./query.js";
import * as auditSchema from "./schema.js";
import { auditCaseNotes, auditChain, auditEvents, auditTombstones } from "./schema.js";

const DAY = 86_400_000;

async function drain(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  return Buffer.concat(chunks).toString("utf8");
}

async function rejects(p: Promise<unknown>, reason: string): Promise<void> {
  const error = await p.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).reasonCode).toBe(reason);
}

describe("audit center (real MySQL, real emitter)", () => {
  let t: TestDb;
  let h: TestHarness;
  let emitter: DurableAuditEmitter;
  let mod: AuditModule;
  let admin: SessionPrincipal;
  let admin2: SessionPrincipal;
  const users = new Map<number, { id: number; publicId: string; role: string; status: string }>();

  const window = () => ({ from: new Date(h.clock.now().getTime() - 380 * DAY).toISOString(), to: new Date(h.clock.now().getTime() + DAY).toISOString() });
  const emit = async (n: number, opts: { category?: AuditCategory; occurredAt?: Date; name?: string; correlationId?: string } = {}) => {
    for (let i = 0; i < n; i += 1) {
      await emitter.record({
        category: opts.category ?? "business",
        eventName: opts.name ?? "order.updated",
        action: "update",
        outcome: "completed",
        actor: { userId: 7, role: "staff" },
        resource: { type: "order", publicId: "01JD00000000000000000000" + String(10 + i).slice(-2) },
        occurredAt: opts.occurredAt,
        correlationId: opts.correlationId,
      });
      h.clock.advance(1000);
    }
  };
  const countEvents = async (name: string) => {
    const [r] = await t.db.select({ n: sql<number>`count(*)` }).from(auditEvents).where(eq(auditEvents.eventName, name));
    return Number(r?.n ?? 0);
  };

  beforeAll(async () => {
    t = await createTestDb({ schema: auditSchema });
  });
  afterAll(() => t.cleanup());

  beforeEach(async () => {
    const s = auditSchema;
    for (const table of [s.auditCaseNotes, s.auditCaseEvents, s.auditCases, s.auditSavedQueries, s.auditExports, s.auditRetentionRuns, s.auditRetentionPolicies, s.auditLegalHolds, s.auditTombstones, s.auditCheckpoints, s.auditChain, s.auditChainHead, s.auditEvents]) {
      await t.db.delete(table);
    }
    h = createTestDeps({ db: t.db });
    emitter = createAuditEmitter({ config: h.config, db: t.db, clock: h.clock, logger: silentLogger, crypto: h.deps.crypto });
    admin = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
    admin2 = fakePrincipal({ role: "admin", stepUpAt: h.clock.now() });
    users.clear();
    for (const p of [admin, admin2]) users.set(p.userId, { id: p.userId, publicId: p.userPublicId, role: "admin", status: "active" });
    const identity = {
      getUser: async (id: number) => users.get(id) ?? null,
      getUserByPublicId: async (publicId: string) => [...users.values()].find((u) => u.publicId === publicId) ?? null,
    };
    (h.deps as { audit: unknown }).audit = emitter;
    (h.services as unknown as Record<string, unknown>).audit = emitter;
    (h.services as unknown as Record<string, unknown>).identity = identity as unknown as Services["identity"];
    mod = createAuditModule(h.deps);
  });

  describe("search", () => {
    it("returns newest first, is self-audited, and honours correlation filters", async () => {
      await emit(3, { correlationId: "wf-alpha" });
      await emit(2, { correlationId: "wf-beta" });
      const page = await mod.search(admin, { query: { ...window(), where: { kind: "group", op: "and", terms: [{ field: "correlation_id", op: "eq", value: "wf-alpha" }] } } });
      expect(page.items).toHaveLength(3);
      expect(page.items.every((e) => e.correlation_id === "wf-alpha")).toBe(true);
      const times = page.items.map((e) => e.occurred_at);
      expect([...times].sort().reverse()).toEqual(times);
      expect(await countEvents("audit.search.executed")).toBe(1);
    });

    it("cursor pagination is stable while new events arrive", async () => {
      await emit(7);
      const query = window();
      const p1 = await mod.search(admin, { query, limit: 3 });
      await emit(2); // newer events land in front, must not shift later pages
      const p2 = await mod.search(admin, { query, limit: 3, cursor: p1.nextCursor });
      const p3 = await mod.search(admin, { query, limit: 3, cursor: p2.nextCursor });
      const ids = [...p1.items, ...p2.items, ...p3.items].filter((e) => e.event_name === "order.updated").map((e) => e.event_id);
      expect(new Set(ids).size).toBe(ids.length);
      // 7 original business events + self-audit rows are interleaved by time; all 7 originals appear exactly once.
      const originals = await t.db.select({ id: auditEvents.eventId }).from(auditEvents).where(eq(auditEvents.eventName, "order.updated")).orderBy(auditEvents.id).limit(7);
      const seen = new Set<string>();
      let cursor: string | null = null;
      for (let i = 0; i < 10; i += 1) {
        const p = await mod.search(admin, { query, limit: 3, cursor });
        p.items.forEach((e) => seen.add(e.event_id));
        cursor = p.nextCursor;
        if (!cursor) break;
      }
      for (const o of originals) expect(seen.has(o.id)).toBe(true);
    });

    it("binds hostile values as parameters (SQL injection attempts match nothing and do not error)", async () => {
      await emit(2);
      for (const value of ["' OR 1=1 --", "x\\' OR \\'1\\'=\\'1", "order.updated\"; DROP TABLE audit_events; --", "%", "_"]) {
        // Either the per-field value grammar rejects it (VALIDATION) or it is bound and matches nothing.
        const outcome = await mod
          .search(admin, { query: { ...window(), where: { kind: "group", op: "or", terms: [{ field: "event_name", op: "eq", value }, { field: "request_id", op: "prefix", value }] } } })
          .then((page) => page.items.filter((e) => e.event_name === "order.updated").length, (e: unknown) => (e instanceof DomainError && e.code === "VALIDATION" ? "rejected" : e));
        expect([0, "rejected"]).toContain(outcome);
      }
      expect(await countEvents("order.updated")).toBe(2);
    });

    it("rejects unknown fields, deep nesting, oversized queries and windows — without recursion blow-ups", () => {
      expect(() => compileQuery({ ...window(), where: { kind: "group", op: "and", terms: [{ field: "1=1; --", op: "eq", value: "x" }] } })).toThrow(DomainError);
      const nest = (d: number): unknown => (d === 0 ? { field: "category", op: "eq", value: "security" } : { kind: "group", op: "and", terms: [nest(d - 1)] });
      expect(auditQuerySchema.safeParse({ ...window(), where: nest(MAX_DEPTH) }).success).toBe(true);
      expect(auditQuerySchema.safeParse({ ...window(), where: nest(MAX_DEPTH + 1) }).success).toBe(false);
      expect(auditQuerySchema.safeParse({ ...window(), where: nest(5000) }).success).toBe(false); // iterative pre-check, no stack overflow
      const many = Array.from({ length: 31 }, () => ({ field: "category", op: "eq", value: "security" }));
      expect(() => compileQuery({ ...window(), where: { kind: "group", op: "or", terms: many } })).toThrow(DomainError);
      const wide = { from: new Date(h.clock.now().getTime() - 500 * DAY).toISOString(), to: h.clock.now().toISOString() };
      expect(() => compileQuery(wide)).toThrow(DomainError);
      expect(auditQuerySchema.safeParse({ ...window(), where: { kind: "group", op: "and", terms: [{ field: "category", op: "in", value: Array.from({ length: 26 }, () => "a") }] } }).success).toBe(false);
    });

    it("budgets unindexed attribute conditions: at most 3 terms and a 31-day window", () => {
      const attr = (i: number) => ({ field: "attribute", key: `k${i}`, op: "eq", value: "open" });
      const g = (n: number) => ({ kind: "group", op: "and", terms: Array.from({ length: n }, (_, i) => attr(i)) });
      const month = { from: new Date(h.clock.now().getTime() - 30 * DAY).toISOString(), to: h.clock.now().toISOString() };
      const quarter = { from: new Date(h.clock.now().getTime() - 90 * DAY).toISOString(), to: h.clock.now().toISOString() };
      expect(compileQuery({ ...month, where: g(3) }).termCount).toBe(3);
      expect(() => compileQuery({ ...month, where: g(4) })).toThrow(DomainError);
      expect(() => compileQuery({ ...quarter, where: g(1) })).toThrow(DomainError);
      expect(compileQuery({ ...quarter, where: { kind: "group", op: "and", terms: [{ field: "category", op: "eq", value: "security" }] } }).termCount).toBe(1);
    });
  });

  describe("authorization (zero trust, re-checked in the service)", () => {
    it("denies customers, staff, remediation sessions and stale step-up", async () => {
      const q = { query: window() };
      await rejects(mod.search(fakePrincipal({ role: "customer" }), q), "CAPABILITY_NOT_GRANTED");
      await rejects(mod.search(fakePrincipal({ role: "staff" }), q), "CAPABILITY_NOT_GRANTED");
      await rejects(mod.search(fakePrincipal({ role: "admin", state: "remediation" }), q), "ACCOUNT_STEP_PENDING");
      const stale = fakePrincipal({ role: "admin", stepUpAt: new Date(h.clock.now().getTime() - 11 * 60_000) });
      await rejects(mod.requestExport(stale, { format: "jsonl", profile: "external", query: window() }), "STEP_UP_REQUIRED");
      const future = fakePrincipal({ role: "admin", stepUpAt: new Date(h.clock.now().getTime() + 60_000) });
      await rejects(mod.setRetentionPolicy(future, { category: "business", retainDays: 90 }), "STEP_UP_REQUIRED");
      await rejects(mod.createCheckpoint(fakePrincipal({ role: "admin" })), "STEP_UP_REQUIRED");
    });

    it("re-validates the actor inside the transaction (demoted/disabled admin is refused)", async () => {
      users.set(admin.userId, { ...users.get(admin.userId)!, status: "disabled" });
      await rejects(mod.requestExport(admin, { format: "jsonl", profile: "external", query: window() }), "ACTOR_NO_LONGER_AUTHORISED");
      await rejects(mod.setRetentionPolicy(admin, { category: "business", retainDays: 90 }), "ACTOR_NO_LONGER_AUTHORISED");
      await rejects(mod.createCase(admin, { title: "Synthetic case", severity: "WARN" }), "ACTOR_NO_LONGER_AUTHORISED");
    });
  });

  describe("exports", () => {
    it("generates via the job into private storage with a pinned snapshot; requester-only, truthful download audit", async () => {
      await emit(4);
      const { id } = await mod.requestExport(admin, { format: "jsonl", profile: "external", query: window() });
      await emit(1, { name: "order.late_arrival" }); // after request, before job: in snapshot (sealed at job start)
      const [result] = await h.jobs.runAll("audit.export.generate");
      expect(result).toMatchObject({ outcome: "completed" });
      const [view] = await mod.listExports(admin);
      expect(view).toMatchObject({ id, status: "completed" });
      expect(view!.manifest).toMatchObject({ manifest_version: "rp.audit.export/1", completeness: "complete" });
      expect(view!.manifest!.chain_head_seq).toBeGreaterThan(0);
      await rejects(mod.openExportDownload(admin2, id), "AUDIT_EXPORT_NOT_FOUND");
      expect(await mod.listExports(admin2)).toHaveLength(0);
      const file = await mod.openExportDownload(admin, id);
      const lines = (await drain(file.stream)).trim().split("\n");
      expect(lines.length).toBe(view!.rowCount);
      for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
      expect(lines.join("\n")).not.toContain("source_address\"");
      expect(await countEvents("audit.export.download_attempted")).toBe(1);
      expect(await countEvents("audit.export.downloaded")).toBe(0);
      await mod.recordDownloadResult(admin, id, "completed");
      expect(await countEvents("audit.export.downloaded")).toBe(1);
      expect(await countEvents("audit.export.completed")).toBe(1);
    });

    it("cancels the job if the requester is no longer an active admin", async () => {
      const { id } = await mod.requestExport(admin, { format: "csv", profile: "external", query: window() });
      users.set(admin.userId, { ...users.get(admin.userId)!, role: "staff" });
      const [result] = await h.jobs.runAll("audit.export.generate");
      expect(result).toMatchObject({ outcome: "canceled", reasonCode: "EXPORT_REQUESTER_INELIGIBLE" });
      users.set(admin.userId, { ...users.get(admin.userId)!, role: "admin" });
      expect((await mod.listExports(admin)).find((e) => e.id === id)?.status).toBe("canceled");
    });

    it("caps active exports per user", async () => {
      for (let i = 0; i < 3; i += 1) await mod.requestExport(admin, { format: "cef", profile: "external", query: window() });
      await rejects(mod.requestExport(admin, { format: "cef", profile: "external", query: window() }), "EXPORT_LIMIT");
    });
  });

  describe("retention, legal holds and chain integrity", () => {
    it("removes only eligible sealed events, keeps held ones, audits each batch in-tx, and the chain still verifies", async () => {
      const old = new Date(h.clock.now().getTime() - 100 * DAY);
      await emit(3, { category: "business", occurredAt: old });
      const heldAt = new Date(h.clock.now().getTime() - 90 * DAY);
      await emit(2, { category: "business", occurredAt: heldAt });
      await emit(2, { category: "business" }); // recent
      await mod.setRetentionPolicy(admin, { category: "business", retainDays: 30 });
      await mod.createLegalHold(admin, { label: "Synthetic matter", categories: ["business"], from: new Date(heldAt.getTime() - DAY).toISOString(), to: new Date(heldAt.getTime() + DAY).toISOString() });
      await mod.sealPending();

      const preview = await mod.runRetention(admin, true);
      expect(preview.counts.business).toBe(3);
      expect(await countEvents("order.updated")).toBe(7);

      const run = await mod.runRetention(admin, false);
      expect(run).toMatchObject({ status: "completed", counts: { business: 3 } });
      expect(run.checkpointId).not.toBeNull();
      expect(await countEvents("order.updated")).toBe(4);
      expect(await countEvents("audit.retention.started")).toBe(1);
      expect(await countEvents("audit.retention.batch_removed")).toBe(1);
      const verify = await mod.verifyIntegrity(admin);
      expect(verify).toMatchObject({ ok: true, pruned: 3 });
      expect(await countEvents("audit.integrity.verified")).toBe(1);
    });

    it("SIEM read continues past retention-only windows and separates pruned from unexplained missing seqs", async () => {
      await emit(3, { occurredAt: new Date(h.clock.now().getTime() - 100 * DAY) });
      await emit(3);
      await mod.setRetentionPolicy(admin, { category: "business", retainDays: 30 });
      await mod.sealPending();
      await mod.runRetention(admin, false);
      const first = await mod.readEventsAfter(null, 2);
      expect(first.pruned).toBe(3);
      expect(first.missing).toBe(0);
      expect(first.events.length).toBeGreaterThan(0);
      const [victim] = await t.db.select().from(auditChain).where(eq(auditChain.seq, 5));
      await t.db.delete(auditEvents).where(eq(auditEvents.id, victim!.eventRowId));
      const again = await mod.readEventsAfter(null, 1000);
      expect(again).toMatchObject({ pruned: 3, missing: 1 });
      const tail = await mod.readEventsAfter(again.nextCursor, 1000);
      expect(tail.events).toHaveLength(0);
      expect(tail.nextCursor).toBe(again.nextCursor);
      // A forged tombstone (bad receipt) and a deleted chain row are both unexplained loss, not pruning.
      const [s6] = await t.db.select({ chain: auditChain, event: auditEvents }).from(auditChain).innerJoin(auditEvents, eq(auditEvents.id, auditChain.eventRowId)).where(eq(auditChain.seq, 6));
      await t.db.insert(auditTombstones).values({ eventRowId: s6!.event.id, eventId: s6!.chain.eventId, seq: 6, eventDigest: s6!.chain.eventDigest, category: "business", occurredAt: s6!.event.occurredAt, retentionRunId: "01JD0000000000000000000000", removedAt: h.clock.now(), receipt: "0".repeat(64) });
      await t.db.delete(auditEvents).where(eq(auditEvents.id, s6!.event.id));
      await t.db.delete(auditChain).where(eq(auditChain.seq, 7));
      expect(await mod.readEventsAfter(null, 1000)).toMatchObject({ pruned: 3, missing: 3 });
    });

    it("a DB-only actor cannot disguise a deletion as pruning (tombstone receipts are keyed)", async () => {
      await emit(3);
      await mod.sealPending();
      const [victim] = await t.db.select({ chain: auditChain, event: auditEvents }).from(auditChain).innerJoin(auditEvents, eq(auditEvents.id, auditChain.eventRowId)).where(eq(auditChain.seq, 2));
      await t.db.insert(auditTombstones).values({
        eventRowId: victim!.event.id,
        eventId: victim!.chain.eventId,
        seq: 2,
        eventDigest: victim!.chain.eventDigest,
        category: "business",
        occurredAt: victim!.event.occurredAt,
        retentionRunId: "01JD0000000000000000000000",
        removedAt: h.clock.now(),
        receipt: "0".repeat(64),
      });
      await t.db.delete(auditEvents).where(eq(auditEvents.id, victim!.event.id));
      const verify = await mod.verifyIntegrity(admin);
      expect(verify.firstBreak).toMatchObject({ seq: 2, reason: "EVENT_MISSING" });
      expect(await countEvents("audit.integrity.break_detected")).toBe(1);
    });

    it("refuses to extend a chain under a different key", async () => {
      await emit(2);
      await mod.sealPending();
      const other = createChainService({ db: t.db, clock: h.clock, logger: silentLogger, auditChainKey: Buffer.alloc(32, 7).toString("base64"), installationId: h.config.installationId });
      await emit(1);
      await expect(other.sealPending()).rejects.toBeInstanceOf(ChainKeyMismatchError);
      await expect(other.createCheckpoint("test")).rejects.toBeInstanceOf(ChainKeyMismatchError);
    });

    it("manual checkpoint is step-up gated and audited in the same transaction", async () => {
      await emit(2);
      const cp = await mod.createCheckpoint(admin);
      expect(cp.seq).toBeGreaterThan(0);
      expect(await countEvents("audit.checkpoint.created")).toBe(1);
      expect((await mod.listCheckpoints(admin))[0]?.id).toBe(cp.publicId);
    });
  });

  describe("cases and saved queries", () => {
    it("creates cases with events, encrypts notes, blocks attaching to a closed case", async () => {
      await emit(2);
      const [ev] = await t.db.select({ id: auditEvents.eventId }).from(auditEvents).where(eq(auditEvents.eventName, "order.updated")).limit(1);
      const { id } = await mod.createCase(admin, { title: "Synthetic investigation", severity: "WARN", eventIds: [ev!.id] });
      await mod.addCaseNote(admin, id, "Synthetic note text");
      const detail = await mod.getCase(admin, id);
      expect(detail.events.map((e) => e.event_id)).toEqual([ev!.id]);
      expect(detail.notes[0]?.body).toBe("Synthetic note text");
      const [raw] = await t.db.select().from(auditCaseNotes);
      expect(raw!.bodyEnc).not.toContain("Synthetic note text");
      await mod.updateCaseStatus(admin, id, "closed");
      await rejects(mod.attachEvents(admin, id, [ev!.id]), "CASE_CLOSED");
      expect(await countEvents("audit.case.created")).toBe(1);
      expect(await countEvents("audit.case.note_added")).toBe(1);
    });

    it("events in an open case are protected from retention", async () => {
      await emit(1, { occurredAt: new Date(h.clock.now().getTime() - 60 * DAY) });
      const [ev] = await t.db.select({ id: auditEvents.eventId }).from(auditEvents).where(eq(auditEvents.eventName, "order.updated"));
      await mod.createCase(admin, { title: "Synthetic protect", severity: "INFO", eventIds: [ev!.id] });
      await mod.setRetentionPolicy(admin, { category: "business", retainDays: 30 });
      const run = await mod.runRetention(admin, false);
      expect(run.counts.business).toBe(0);
      expect(await countEvents("order.updated")).toBe(1);
    });

    it("saved queries are owner-scoped for deletion", async () => {
      const { id } = await mod.saveQuery(admin, { name: "Failed logins", shared: true, query: window() });
      expect((await mod.listSavedQueries(admin2)).find((q) => q.id === id)?.mine).toBe(false);
      await rejects(mod.deleteSavedQuery(admin2, id), "NOT_FOUND");
      await mod.deleteSavedQuery(admin, id);
      expect(await mod.listSavedQueries(admin)).toHaveLength(0);
    });
  });

  it("health reports store, notes and chain components", async () => {
    await emit(1);
    const health = await mod.health!();
    expect(health.map((c) => c.component).sort()).toEqual(["audit.chain", "audit.notes", "audit.store"]);
    const rows = await t.db.select().from(auditEvents).where(and(eq(auditEvents.eventName, "order.updated")));
    expect(rows).toHaveLength(1);
  });
});
