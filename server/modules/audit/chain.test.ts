import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDeps, silentLogger } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createChainService, deriveChainKeys, type ChainService } from "./chain.js";
import { createAuditEmitter, type DurableAuditEmitter } from "./emitter.js";
import * as auditSchema from "./schema.js";
import { auditChain, auditChainHead, auditCheckpoints, auditEvents } from "./schema.js";

describe("audit hash chain (real MySQL)", () => {
  let t: TestDb;
  let emitter: DurableAuditEmitter;
  let chain: ChainService;
  const h = createTestDeps();

  const emit = (n: number, prefix = "test.event") =>
    Promise.all(
      Array.from({ length: n }, (_, i) =>
        emitter.record({ category: "system", eventName: `${prefix}.e${i % 5}`, action: "test", outcome: "completed", safeCounts: { i } }),
      ),
    );

  beforeAll(async () => {
    t = await createTestDb({ schema: { ...auditSchema } });
    emitter = createAuditEmitter({ config: h.config, db: t.db, clock: h.clock, logger: silentLogger, crypto: h.deps.crypto });
    chain = createChainService({ db: t.db, clock: h.clock, logger: silentLogger, auditChainKey: h.config.auditChainKey, installationId: h.config.installationId });
  });
  afterAll(() => t.cleanup());
  beforeEach(async () => {
    for (const table of [auditEvents, auditChain, auditChainHead, auditCheckpoints]) await t.db.delete(table);
  });

  it("seals committed events with consecutive seq and verifies clean", async () => {
    await emit(12);
    expect(await chain.sealPending()).toMatchObject({ sealed: 12, headSeq: 12 });
    expect(await chain.sealPending()).toMatchObject({ sealed: 0, headSeq: 12 });
    await emit(3);
    await chain.sealPending();
    const result = await chain.verify();
    expect(result).toMatchObject({ ok: true, checked: 15, headSeq: 15, firstBreak: null, complete: true });
  });

  it("chains events that commit out of id order (late commit gets a later seq)", async () => {
    // Open a transaction that takes an auto-increment id, let a later event commit and be sealed first.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inserted!: () => void;
    const insertedSignal = new Promise<void>((resolve) => (inserted = resolve));
    const slow = t.db.transaction(async (tx) => {
      await emitter.record({ category: "business", eventName: "slow.tx.event", action: "create", outcome: "completed" }, tx);
      inserted();
      await gate;
    });
    await insertedSignal;
    await emitter.record({ category: "business", eventName: "fast.tx.event", action: "create", outcome: "completed" });
    expect((await chain.sealPending()).sealed).toBe(1);
    release();
    await slow;
    expect((await chain.sealPending()).sealed).toBe(1);
    const rows = await t.db.select().from(auditChain).orderBy(auditChain.seq);
    const events = await t.db.select().from(auditEvents);
    const byRow = new Map(events.map((e) => [e.id, e.eventName]));
    expect(rows.map((r) => byRow.get(r.eventRowId))).toEqual(["fast.tx.event", "slow.tx.event"]);
    // The slow event has the LOWER row id but the HIGHER seq.
    expect(rows[1]!.eventRowId).toBeLessThan(rows[0]!.eventRowId);
    expect((await chain.verify()).ok).toBe(true);
  });

  it("detects modification of an event row", async () => {
    await emit(6);
    await chain.sealPending();
    const [victim] = await t.db.select().from(auditChain).where(eq(auditChain.seq, 4));
    await t.db.update(auditEvents).set({ outcome: "failed" }).where(eq(auditEvents.id, victim!.eventRowId));
    const result = await chain.verify();
    expect(result.ok).toBe(false);
    expect(result.firstBreak).toEqual({ seq: 4, eventId: victim!.eventId, reason: "DIGEST_MISMATCH" });
  });

  it("detects modification of JSON attributes and of the encrypted-address-free canonical fields", async () => {
    await emit(3);
    await chain.sealPending();
    const [victim] = await t.db.select().from(auditChain).where(eq(auditChain.seq, 2));
    await t.db.update(auditEvents).set({ safeCounts: { i: 999 } }).where(eq(auditEvents.id, victim!.eventRowId));
    expect((await chain.verify()).firstBreak?.reason).toBe("DIGEST_MISMATCH");
  });

  it("detects deletion of an event row without a retention tombstone", async () => {
    await emit(5);
    await chain.sealPending();
    const [victim] = await t.db.select().from(auditChain).where(eq(auditChain.seq, 3));
    await t.db.delete(auditEvents).where(eq(auditEvents.id, victim!.eventRowId));
    expect((await chain.verify()).firstBreak).toMatchObject({ seq: 3, reason: "EVENT_MISSING" });
  });

  it("a partial-range success never overwrites the global verifier status; any break is persisted", async () => {
    await emit(6);
    await chain.sealPending();
    const status = async () => (await t.db.select().from(auditChainHead))[0]!;
    expect((await chain.verify({ fromSeq: 4 })).ok).toBe(true);
    expect((await status()).lastVerifiedAt).toBeNull();
    expect((await chain.verify({ maxEvents: 2 })).complete).toBe(false);
    expect((await status()).lastVerifiedAt).toBeNull();
    const [victim] = await t.db.select().from(auditChain).where(eq(auditChain.seq, 5));
    await t.db.update(auditEvents).set({ outcome: "failed" }).where(eq(auditEvents.id, victim!.eventRowId));
    expect((await chain.verify({ fromSeq: 4 })).ok).toBe(false);
    expect(await status()).toMatchObject({ lastVerifyOk: false, lastVerifyBreakSeq: 5 });
    // A later PARTIAL success must not clear the recorded break.
    expect((await chain.verify({ fromSeq: 1, maxEvents: 3 })).ok).toBe(true);
    expect(await status()).toMatchObject({ lastVerifyOk: false, lastVerifyBreakSeq: 5 });
  });

  it("detects deletion of a chain link (seq gap)", async () => {
    await emit(5);
    await chain.sealPending();
    await t.db.delete(auditChain).where(eq(auditChain.seq, 2));
    expect((await chain.verify()).firstBreak).toMatchObject({ seq: 2, reason: "SEQ_GAP" });
  });

  it("detects reordering (two chain rows swapping their events)", async () => {
    await emit(5);
    await chain.sealPending();
    const [a] = await t.db.select().from(auditChain).where(eq(auditChain.seq, 2));
    const [b] = await t.db.select().from(auditChain).where(eq(auditChain.seq, 3));
    // Swap the event pointers (+ ids) of seq 2 and 3, keeping digests: link hashes still match but digests won't.
    await t.db.execute(sql`UPDATE audit_chain SET event_row_id = event_row_id + 1000000, event_id = 'XXXXXXXXXXXXXXXXXXXXXXXXX1' WHERE seq = 2`);
    await t.db.update(auditChain).set({ eventRowId: a!.eventRowId, eventId: a!.eventId }).where(eq(auditChain.seq, 3));
    await t.db.update(auditChain).set({ eventRowId: b!.eventRowId, eventId: b!.eventId }).where(eq(auditChain.seq, 2));
    const result = await chain.verify();
    expect(result.ok).toBe(false);
    expect(result.firstBreak?.seq).toBe(2);
    expect(["DIGEST_MISMATCH", "EVENT_ID_MISMATCH"]).toContain(result.firstBreak?.reason);
  });

  it("detects a forged link (attacker without the chain key recomputes a plain hash)", async () => {
    await emit(4);
    await chain.sealPending();
    await t.db.update(auditChain).set({ linkHash: "0".repeat(64) }).where(eq(auditChain.seq, 2));
    expect((await chain.verify()).firstBreak).toMatchObject({ seq: 2, reason: "LINK_MISMATCH" });
  });

  it("detects tail truncation via head and via signed checkpoints", async () => {
    await emit(6);
    await chain.sealPending();
    const cp = await chain.createCheckpoint("test");
    expect(cp.seq).toBe(6);
    expect((await chain.verify()).checkpointsVerified).toBe(1);
    await t.db.delete(auditChain).where(eq(auditChain.seq, 6));
    expect((await chain.verify()).firstBreak?.reason).toBe("HEAD_MISMATCH");
    // Attacker also rewinds the head: the signed checkpoint still catches it.
    const [five] = await t.db.select().from(auditChain).where(eq(auditChain.seq, 5));
    await t.db.update(auditChainHead).set({ headSeq: 5, headHash: five!.linkHash });
    expect((await chain.verify()).firstBreak).toMatchObject({ seq: 6, reason: "CHECKPOINT_MISMATCH" });
  });

  it("rejects a checkpoint whose signature was tampered", async () => {
    await emit(2);
    await chain.sealPending();
    await chain.createCheckpoint("test");
    await t.db.update(auditCheckpoints).set({ headHash: "f".repeat(64) });
    expect((await chain.verify()).firstBreak?.reason).toBe("CHECKPOINT_SIGNATURE_INVALID");
  });

  it("derives distinct keys per installation and never exposes the secret", () => {
    const a = deriveChainKeys(h.config.auditChainKey, "install-a");
    const b = deriveChainKeys(h.config.auditChainKey, "install-b");
    expect(a.genesis).not.toBe(b.genesis);
    expect(a.publicKeyB64).not.toBe(b.publicKeyB64);
    expect(a.publicKeyB64).not.toContain(h.config.auditChainKey);
  });
});
