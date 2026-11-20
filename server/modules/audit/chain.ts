/**
 * Tamper evidence: per-installation HMAC hash chain, sealing, verification and signed checkpoints.
 * Owner: audit engineer.
 *
 * DESIGN (why sealing is separate from writing)
 *   Business transactions insert audit rows concurrently and may commit out of auto-increment order.
 *   Assigning prev_hash at insert time would either serialise every audited write on one hot row or
 *   produce forks. Instead:
 *     1. `record()` inserts the envelope only (inside the caller's tx).
 *     2. The sealer (job `audit.chain.seal`, every 10 s, and on demand) takes the singleton
 *        `audit_chain_head` row FOR UPDATE (one sealer at a time across all workers), finds COMMITTED
 *        event rows that have no `audit_chain` row (LEFT JOIN on a unique index), and appends them in
 *        id order with consecutive `seq` values. A row that commits late simply gets a later seq.
 *     3. Chain order = seq order = an order in which every event was already committed, which is also
 *        the commit-safe read order offered to SIEM (`readEventsAfter`).
 *   Scan bound: rows with id <= scan_watermark are never rescanned. The watermark advances only to an id
 *   observed at least HORIZON_MS ago (a transaction holding an older id has had that long to commit).
 *   A transaction open longer than the horizon could be missed by the incremental scan: the daily full
 *   sweep (`sealPending({ fullScan: true })`) seals it, and `verifyChain` reports unsealed rows older than
 *   the horizon as a coverage warning. This is stated in VERIFICATION.md.
 *
 *   event_digest = SHA-256(canonicalBytes(envelope))
 *   link_hash    = HMAC-SHA-256(K_chain, "rp.audit.chain/1|" + seq + "|" + prev_hash + "|" + event_digest)
 *   Detects: modified event rows (digest), deleted event rows without a retention tombstone, deleted /
 *   inserted / reordered chain rows (seq gap / prev / link), tail truncation (head + signed checkpoints).
 *   Checkpoints are Ed25519-signed with a key derived (HKDF) from the chain key; the public key is stored
 *   with each checkpoint so an external party can verify a published checkpoint without the secret.
 *   LIMITS: this is tamper EVIDENCE. Anyone holding the chain key (root on the host) can rewrite history
 *   and re-sign; independent immutable retention (SIEM copy, exported checkpoints) is the mitigation.
 */
import { createHash, createHmac, createPrivateKey, createPublicKey, hkdfSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, max, sql } from "drizzle-orm";
import { ulid } from "../../core/ids.js";
import type { Clock, Db, DbOrTx, Logger } from "../../core/types.js";
import { canonicalBytes, type AuditEnvelope } from "./envelope.js";
import { rowToEnvelope } from "./rows.js";
import { auditChain, auditChainHead, auditCheckpoints, auditEvents, auditTombstones } from "./schema.js";

export const CHAIN_VERSION = "rp.audit.chain/1";
export const CHECKPOINT_VERSION = "rp.audit.checkpoint/1";
export const HORIZON_MS = 15 * 60 * 1000;
export const SEAL_BATCH = 500;
const HEAD_ID = 1;

export interface ChainKeys {
  keyRef: string;
  genesis: string;
  link(seq: number, prevHash: string, digest: string): string;
  signingKey: KeyObject;
  publicKeyB64: string;
  signingKeyRef: string;
}

export function deriveChainKeys(auditChainKey: string, installationId: string): ChainKeys {
  const key = Buffer.from(auditChainKey, "base64");
  const hmacKey = Buffer.from(hkdfSync("sha256", key, Buffer.from(installationId), Buffer.from("rp.audit.chain.hmac/1"), 32));
  const seed = Buffer.from(hkdfSync("sha256", key, Buffer.from(installationId), Buffer.from("rp.audit.checkpoint.ed25519/1"), 32));
  // PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410).
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const signingKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const spki = createPublicKey(signingKey).export({ format: "der", type: "spki" });
  const publicKeyB64 = Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
  const mac = (input: string) => createHmac("sha256", hmacKey).update(input, "utf8").digest("hex");
  return {
    keyRef: mac("key-ref").slice(0, 16),
    genesis: mac(`${CHAIN_VERSION}|genesis|${installationId}`),
    link: (seq, prevHash, digest) => mac(`${CHAIN_VERSION}|${seq}|${prevHash}|${digest}`),
    signingKey,
    publicKeyB64,
    signingKeyRef: createHash("sha256").update(publicKeyB64).digest("hex").slice(0, 16),
  };
}

export function eventDigest(envelope: AuditEnvelope): string {
  return createHash("sha256").update(canonicalBytes(envelope), "utf8").digest("hex");
}

export function checkpointMessage(installationId: string, seq: number, headHash: string, signedAt: Date): string {
  return `${CHECKPOINT_VERSION}|${installationId}|${seq}|${headHash}|${signedAt.toISOString()}`;
}

export function verifyCheckpointSignature(publicKeyB64: string, message: string, signatureB64: string): boolean {
  try {
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyB64, "base64")]);
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    return edVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export type BreakReason =
  | "SEQ_GAP"
  | "PREV_MISMATCH"
  | "LINK_MISMATCH"
  | "DIGEST_MISMATCH"
  | "EVENT_MISSING"
  | "EVENT_ID_MISMATCH"
  | "HEAD_MISMATCH"
  | "CHECKPOINT_MISMATCH"
  | "CHECKPOINT_SIGNATURE_INVALID";

export interface ChainVerification {
  ok: boolean;
  checked: number;
  pruned: number;
  fromSeq: number;
  lastSeq: number;
  headSeq: number;
  complete: boolean;
  firstBreak: { seq: number; eventId: string | null; reason: BreakReason } | null;
  checkpointsVerified: number;
  unsealedOlderThanHorizon: number;
  verifiedAt: string;
}

export interface ChainService {
  keys: ChainKeys;
  sealPending(options?: { fullScan?: boolean; maxBatches?: number }): Promise<{ sealed: number; headSeq: number }>;
  verify(options?: { fromSeq?: number; maxEvents?: number }): Promise<ChainVerification>;
  createCheckpoint(reason: string, db?: DbOrTx): Promise<{ publicId: string; seq: number; headHash: string }>;
  head(): Promise<{ headSeq: number; headHash: string; lastSealedAt: Date | null; lastVerifiedAt: Date | null; lastVerifyOk: boolean | null; lastVerifyBreakSeq: number | null }>;
  unsealedBacklog(): Promise<{ count: number; oldestObservedAt: Date | null }>;
}

export function createChainService(deps: { db: Db; clock: Clock; logger: Logger; auditChainKey: string; installationId: string }): ChainService {
  const keys = deriveChainKeys(deps.auditChainKey, deps.installationId);
  const log = deps.logger.child({ component: "audit.chain" });

  async function ensureHead(db: DbOrTx): Promise<void> {
    await db
      .insert(auditChainHead)
      .values({ id: HEAD_ID, headSeq: 0, headHash: keys.genesis, scanWatermark: 0, watermarkCandidateId: 0 })
      .onDuplicateKeyUpdate({ set: { id: sql`id` } });
  }

  async function sealOnce(fullScan: boolean): Promise<{ sealed: number; headSeq: number; more: boolean }> {
    await ensureHead(deps.db);
    return deps.db.transaction(async (tx) => {
      const [head] = await tx.select().from(auditChainHead).where(eq(auditChainHead.id, HEAD_ID)).for("update");
      if (!head) throw new Error("audit chain head missing");
      const floor = fullScan ? 0 : head.scanWatermark;
      const candidates = await tx
        .select({ event: auditEvents })
        .from(auditEvents)
        .leftJoin(auditChain, eq(auditChain.eventRowId, auditEvents.id))
        .where(and(gt(auditEvents.id, floor), isNull(auditChain.eventRowId)))
        .orderBy(asc(auditEvents.id))
        .limit(SEAL_BATCH);
      const now = deps.clock.now();
      let seq = head.headSeq;
      let prev = head.headHash;
      const rows: (typeof auditChain.$inferInsert)[] = [];
      for (const { event } of candidates) {
        seq += 1;
        const digest = eventDigest(rowToEnvelope(event));
        const link = keys.link(seq, prev, digest);
        rows.push({ seq, eventRowId: event.id, eventId: event.eventId, eventDigest: digest, prevHash: prev, linkHash: link, keyRef: keys.keyRef, sealedAt: now });
        prev = link;
      }
      for (let i = 0; i < rows.length; i += 100) await tx.insert(auditChain).values(rows.slice(i, i + 100));

      // Watermark advancement (see header comment).
      const more = candidates.length === SEAL_BATCH;
      let watermark = head.scanWatermark;
      let candidateId = head.watermarkCandidateId;
      let candidateAt = head.watermarkCandidateAt;
      if (!more && candidateAt && now.getTime() - candidateAt.getTime() >= HORIZON_MS && candidateId > watermark) {
        watermark = candidateId;
        candidateAt = null;
      }
      if (!candidateAt) {
        const [top] = await tx.select({ maxId: max(auditEvents.id) }).from(auditEvents);
        candidateId = Number(top?.maxId ?? 0);
        candidateAt = now;
      }
      await tx
        .update(auditChainHead)
        .set({
          headSeq: seq,
          headHash: prev,
          scanWatermark: watermark,
          watermarkCandidateId: candidateId,
          watermarkCandidateAt: candidateAt,
          ...(rows.length > 0 ? { lastSealedAt: now } : {}),
        })
        .where(eq(auditChainHead.id, HEAD_ID));
      return { sealed: rows.length, headSeq: seq, more };
    });
  }

  async function headRow() {
    await ensureHead(deps.db);
    const [head] = await deps.db.select().from(auditChainHead).where(eq(auditChainHead.id, HEAD_ID));
    if (!head) throw new Error("audit chain head missing");
    return head;
  }

  return {
    keys,
    async sealPending(options = {}) {
      let sealed = 0;
      let headSeq = 0;
      const maxBatches = options.maxBatches ?? 20;
      for (let i = 0; i < maxBatches; i += 1) {
        const result = await sealOnce(options.fullScan === true);
        sealed += result.sealed;
        headSeq = result.headSeq;
        if (!result.more) break;
      }
      if (sealed > 0) log.debug("audit events sealed", { sealed, head_seq: headSeq });
      return { sealed, headSeq };
    },

    async verify(options = {}) {
      const fromSeq = Math.max(1, Math.floor(options.fromSeq ?? 1));
      const maxEvents = Math.min(Math.max(1, Math.floor(options.maxEvents ?? 100_000)), 1_000_000);
      const head = await headRow();
      const now = deps.clock.now();
      let expectedPrev = keys.genesis;
      if (fromSeq > 1) {
        const [before] = await deps.db.select().from(auditChain).where(eq(auditChain.seq, fromSeq - 1));
        expectedPrev = before?.linkHash ?? "missing";
      }
      let expectedSeq = fromSeq;
      let checked = 0;
      let pruned = 0;
      let firstBreak: ChainVerification["firstBreak"] = null;
      const linkAt = new Map<number, string>();
      const fail = (seq: number, eventId: string | null, reason: BreakReason) => {
        if (!firstBreak) firstBreak = { seq, eventId, reason };
      };
      outer: while (checked < maxEvents) {
        const page = await deps.db
          .select({ chain: auditChain, event: auditEvents, tomb: auditTombstones })
          .from(auditChain)
          .leftJoin(auditEvents, eq(auditEvents.id, auditChain.eventRowId))
          .leftJoin(auditTombstones, eq(auditTombstones.seq, auditChain.seq))
          .where(gte(auditChain.seq, expectedSeq))
          .orderBy(asc(auditChain.seq))
          .limit(Math.min(500, maxEvents - checked));
        if (page.length === 0) break;
        for (const { chain, event, tomb } of page) {
          if (chain.seq !== expectedSeq) {
            fail(expectedSeq, null, "SEQ_GAP");
            break outer;
          }
          if (chain.prevHash !== expectedPrev) {
            fail(chain.seq, chain.eventId, "PREV_MISMATCH");
            break outer;
          }
          if (keys.link(chain.seq, chain.prevHash, chain.eventDigest) !== chain.linkHash) {
            fail(chain.seq, chain.eventId, "LINK_MISMATCH");
            break outer;
          }
          if (event) {
            if (event.eventId !== chain.eventId) {
              fail(chain.seq, chain.eventId, "EVENT_ID_MISMATCH");
              break outer;
            }
            if (eventDigest(rowToEnvelope(event)) !== chain.eventDigest) {
              fail(chain.seq, chain.eventId, "DIGEST_MISMATCH");
              break outer;
            }
          } else if (tomb && tomb.eventId === chain.eventId && tomb.eventDigest === chain.eventDigest) {
            pruned += 1;
          } else {
            fail(chain.seq, chain.eventId, "EVENT_MISSING");
            break outer;
          }
          linkAt.set(chain.seq, chain.linkHash);
          if (linkAt.size > 2048) linkAt.delete(linkAt.keys().next().value as number);
          expectedPrev = chain.linkHash;
          expectedSeq += 1;
          checked += 1;
        }
      }
      const lastSeq = expectedSeq - 1;
      const complete = !firstBreak && checked < maxEvents;
      if (!firstBreak && complete && (lastSeq !== head.headSeq || (lastSeq > 0 && expectedPrev !== head.headHash))) {
        fail(Math.min(lastSeq + 1, head.headSeq), null, "HEAD_MISMATCH");
      }

      // Signed checkpoints: signature valid, and the chain row at that seq still carries the checkpointed hash.
      let checkpointsVerified = 0;
      if (!firstBreak) {
        const checkpoints = await deps.db.select().from(auditCheckpoints).orderBy(desc(auditCheckpoints.seq)).limit(50);
        for (const cp of checkpoints) {
          const message = checkpointMessage(cp.installationRef, cp.seq, cp.headHash, cp.signedAt);
          if (cp.installationRef !== deps.installationId || cp.publicKey !== keys.publicKeyB64 || !verifyCheckpointSignature(cp.publicKey, message, cp.signature)) {
            fail(cp.seq, null, "CHECKPOINT_SIGNATURE_INVALID");
            break;
          }
          if (cp.seq === 0) {
            if (cp.headHash !== keys.genesis) fail(0, null, "CHECKPOINT_MISMATCH");
          } else {
            const [row] = await deps.db.select({ linkHash: auditChain.linkHash }).from(auditChain).where(eq(auditChain.seq, cp.seq));
            if (!row || row.linkHash !== cp.headHash) {
              fail(cp.seq, null, "CHECKPOINT_MISMATCH");
              break;
            }
          }
          checkpointsVerified += 1;
        }
      }

      const [unsealed] = await deps.db
        .select({ count: sql<number>`count(*)` })
        .from(auditEvents)
        .leftJoin(auditChain, eq(auditChain.eventRowId, auditEvents.id))
        .where(and(isNull(auditChain.eventRowId), lt(auditEvents.observedAt, new Date(now.getTime() - HORIZON_MS))));

      const result: ChainVerification = {
        ok: firstBreak === null,
        checked,
        pruned,
        fromSeq,
        lastSeq,
        headSeq: head.headSeq,
        complete,
        firstBreak,
        checkpointsVerified,
        unsealedOlderThanHorizon: Number(unsealed?.count ?? 0),
        verifiedAt: now.toISOString(),
      };
      const breakInfo = result.firstBreak as ChainVerification["firstBreak"];
      await deps.db
        .update(auditChainHead)
        .set({ lastVerifiedAt: now, lastVerifyOk: result.ok, lastVerifyBreakSeq: breakInfo ? breakInfo.seq : null })
        .where(eq(auditChainHead.id, HEAD_ID));
      if (!result.ok) log.error("audit chain verification failed", { break_seq: breakInfo?.seq, reason: breakInfo?.reason });
      return result;
    },

    async createCheckpoint(reason, db = deps.db) {
      const head = await headRow();
      const signedAt = new Date(Math.floor(deps.clock.now().getTime()));
      const signature = edSign(null, Buffer.from(checkpointMessage(deps.installationId, head.headSeq, head.headHash, signedAt)), keys.signingKey).toString("base64");
      const publicId = ulid(signedAt.getTime());
      await db.insert(auditCheckpoints).values({
        publicId,
        seq: head.headSeq,
        headHash: head.headHash,
        installationRef: deps.installationId,
        signedAt,
        algorithm: "ed25519",
        keyRef: keys.signingKeyRef,
        publicKey: keys.publicKeyB64,
        signature,
        reason: reason.slice(0, 24),
      });
      return { publicId, seq: head.headSeq, headHash: head.headHash };
    },

    async head() {
      const head = await headRow();
      return {
        headSeq: head.headSeq,
        headHash: head.headHash,
        lastSealedAt: head.lastSealedAt,
        lastVerifiedAt: head.lastVerifiedAt,
        lastVerifyOk: head.lastVerifyOk,
        lastVerifyBreakSeq: head.lastVerifyBreakSeq,
      };
    },

    async unsealedBacklog() {
      const head = await headRow();
      const [row] = await deps.db
        .select({ count: sql<number>`count(*)`, oldest: sql<string | null>`min(${auditEvents.observedAt})` })
        .from(auditEvents)
        .leftJoin(auditChain, eq(auditChain.eventRowId, auditEvents.id))
        .where(and(gt(auditEvents.id, head.scanWatermark), isNull(auditChain.eventRowId)));
      const oldest = row?.oldest ? new Date(String(row.oldest).replace(" ", "T") + (String(row.oldest).endsWith("Z") ? "" : "Z")) : null;
      return { count: Number(row?.count ?? 0), oldestObservedAt: oldest };
    },
  };
}

/** Exposed for retention: chain rows for a set of event row ids. */
export async function chainRowsFor(db: DbOrTx, eventRowIds: number[]) {
  if (eventRowIds.length === 0) return [];
  return db.select().from(auditChain).where(inArray(auditChain.eventRowId, eventRowIds));
}
