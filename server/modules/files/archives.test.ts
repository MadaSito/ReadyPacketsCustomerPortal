/**
 * D8 archives against LOCAL FAKES and the local dev MySQL test database: entry names, caps, slot reuse, order-scope
 * re-authorisation, build verification, ticket semantics and stale-download revocation. Synthetic data only.
 */
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import yauzl from "yauzl";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { SessionPrincipal } from "../../core/types.js";
import { users } from "../identity/schema.js";
import { orders } from "../orders/schema.js";
import { archiveEntryNames, isSafeEntryName, sanitiseSegment } from "./archiveNames.js";
import { ARCHIVE_BUILD_JOB, ARCHIVE_LIMITS, createFileArchivesModule, type DeliverableFile, type FileArchivesModule } from "./archives.js";
import { fileArchiveTickets, fileArchives } from "./archivesSchema.js";

let db: TestDb;
let h: TestHarness;
let mod: FileArchivesModule;
let orderId: string;
let customer: SessionPrincipal;
let admin: SessionPrincipal;
let files: (DeliverableFile & { bytes: Buffer })[];
let readable: Set<number>;
let liveSessions: Set<string>;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
function file(name: string, content: string, stageKey: string | null = "design"): DeliverableFile & { bytes: Buffer } {
  const bytes = Buffer.from(content);
  return { publicId: ulid(), version: 1, size: bytes.length, sha256: sha(bytes), displayName: name, extension: name.split(".").pop() ?? null, stageKey, bytes };
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return error instanceof DomainError ? error.reasonCode : "UNEXPECTED"; }
  return "NO_ERROR";
}

function readZip(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out = new Map<string, Buffer>();
      zip.on("entry", (entry: yauzl.Entry) => zip.openReadStream(entry, (e, s) => {
        if (e || !s) return reject(e);
        const chunks: Buffer[] = [];
        s.on("data", (c: Buffer) => chunks.push(c)).on("end", () => { out.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
      }));
      zip.on("end", () => resolve(out));
      zip.readEntry();
    });
  });
}
const drain = async (s: Readable) => { const c: Buffer[] = []; for await (const x of s) c.push(x as Buffer); return Buffer.concat(c); };

beforeAll(async () => {
  db = await createTestDb({ schema: { users, orders, fileArchives, fileArchiveTickets } });
});
afterAll(() => db?.cleanup());

beforeEach(async () => {
  for (const t of [fileArchiveTickets, fileArchives, orders, users]) await db.db.delete(t);
  h = createTestDeps({ db: db.db });
  const now = h.clock.now();
  const [user] = await db.db.insert(users).values({
    publicId: ulid(now.getTime()), role: "customer", status: "active", emailEnc: "test",
    emailIndex: h.deps.crypto.blindIndex("archive@example.test", "users.email"), nameEnc: "test", createdAt: now, updatedAt: now,
  } as never);
  orderId = ulid();
  await db.db.insert(orders).values({
    publicId: orderId, reference: orderId, projectName: "Synthetic order", ownerUserId: Number((user as { insertId: number }).insertId),
    workflowVersionId: 1, statusKey: "intake", subtotalMinor: 0, totalMinor: 0, currency: "USD",
  } as never);
  customer = fakePrincipal({ role: "customer" });
  admin = fakePrincipal({ role: "admin", stepUpAt: now });
  files = [file("plan.pdf", "alpha"), file("Plan.PDF", "beta"), file("notes.txt", "gamma", null)];
  readable = new Set([customer.userId, admin.userId]);
  liveSessions = new Set([customer.sessionId, admin.sessionId]);
  const principals = new Map([customer, admin].map((p) => [p.sessionId, p]));
  const visible = (p: SessionPrincipal, stageKey?: string) => {
    if (!readable.has(p.userId)) throw new DomainError("NOT_FOUND", "ORDER_NOT_FOUND", "Not found.");
    return files.filter((f) => (stageKey ? f.stageKey === stageKey : true));
  };
  h.services.files = {
    async listDeliverableFiles(p: SessionPrincipal, scope: { stageKey?: string; limit?: number }) {
      const items = visible(p, scope.stageKey);
      return { items: items.map(({ bytes: _b, ...rest }) => rest), nextCursor: null };
    },
    async openDeliverableFile(p: SessionPrincipal, scope: { filePublicId: string; stageKey?: string }) {
      const f = visible(p, scope.stageKey).find((x) => x.publicId === scope.filePublicId);
      if (!f) throw new DomainError("NOT_FOUND", "FILE_NOT_FOUND", "Not found.");
      const { bytes, ...rest } = f;
      return { file: rest, stream: Readable.from([bytes]) };
    },
  } as never;
  h.services.identity = {
    sessions: {
      assertCurrent: async (p: SessionPrincipal) => {
        if (!liveSessions.has(p.sessionId)) throw new DomainError("UNAUTHENTICATED", "SESSION_ENDED", "Signed out.");
        return { role: p.role, stepUpAt: p.stepUpAt, pendingSteps: [], mfaVerifiedAt: p.mfaVerifiedAt };
      },
      getState: async (sessionId: string) => {
        const p = principals.get(sessionId);
        return p ? { sessionId, userId: p.userId, userPublicId: p.userPublicId, role: p.role, userStatus: "active", live: liveSessions.has(sessionId),
          revokedAt: null, mfaVerifiedAt: p.mfaVerifiedAt, stepUpAt: p.stepUpAt, authMethod: p.authMethod } : null;
      },
    },
    transitions: { derive: async () => [] },
  } as never;
  mod = createFileArchivesModule(h.deps);
});

async function buildReady(p: SessionPrincipal, stageKey: string | null = "design") {
  const view = await mod.request(p, { orderId, stageKey });
  await h.jobs.runAll(ARCHIVE_BUILD_JOB);
  return (await mod.status(p, view.archiveId)).archiveId;
}

describe("entry names", () => {
  it("sanitises traversal, reserved names, separators and dedupes case-insensitively", () => {
    expect(sanitiseSegment("../../etc/passwd")).not.toContain("/");
    expect(sanitiseSegment("CON.txt")).toBe("_CON.txt");
    expect(sanitiseSegment("..")).toBe("file");
    const names = archiveEntryNames([
      { displayName: "a:b.pdf", stageKey: "s" }, { displayName: "A_B.pdf", stageKey: "s" }, { displayName: "x.txt", stageKey: null },
    ], "order");
    expect(names).toEqual(["s/a_b.pdf", "s/A_B (2).pdf", "Order files/x.txt"]);
    for (const n of names) expect(isSafeEntryName(n)).toBe(true);
    for (const bad of ["../x", "/x", "a\\b", "C:x", "a//b", "con", "a/./b", "x."]) expect(isSafeEntryName(bad)).toBe(false);
  });

  it("terminates and stays unique for duplicate names at the maximum length", () => {
    const long = `${"n".repeat(200)}.pdf`;
    const names = archiveEntryNames(Array.from({ length: 30 }, () => ({ displayName: long, stageKey: null })), "stage");
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(30);
    for (const n of names) { expect(Array.from(n).length).toBeLessThanOrEqual(120); expect(n.endsWith(".pdf")).toBe(true); expect(isSafeEntryName(n)).toBe(true); }
  });
});

describe("request", () => {
  it("refuses more than 250 files and more than 500 MiB, and empty sets", async () => {
    files = Array.from({ length: ARCHIVE_LIMITS.maxFiles + 1 }, (_, i) => file(`f${i}.txt`, "x"));
    expect(await reason(mod.request(customer, { orderId, stageKey: "design" }))).toBe("ARCHIVE_TOO_LARGE");
    files = [{ ...file("big.bin", "x"), size: ARCHIVE_LIMITS.maxBytes + 1 }];
    expect(await reason(mod.request(customer, { orderId, stageKey: "design" }))).toBe("ARCHIVE_TOO_LARGE");
    files = [];
    expect(await reason(mod.request(customer, { orderId, stageKey: "design" }))).toBe("ARCHIVE_EMPTY");
  });

  it("reuses the same request and refuses a second different one", async () => {
    const a = await mod.request(customer, { orderId, stageKey: "design" });
    const b = await mod.request(customer, { orderId, stageKey: "design" });
    expect(b.archiveId).toBe(a.archiveId);
    expect(await reason(mod.request(customer, { orderId, stageKey: null }))).not.toBe("NO_ERROR");
  });

  it("whole-order ZIP needs admin and fresh step-up", async () => {
    expect(await reason(mod.request(customer, { orderId, stageKey: null }))).toBe("CAPABILITY_NOT_GRANTED");
    const stale = { ...admin, stepUpAt: new Date(h.clock.now().getTime() - 60 * 60_000) };
    expect(await reason(mod.request(stale, { orderId, stageKey: null }))).not.toBe("NO_ERROR");
    expect(h.audit.named("file.archive.denied").length).toBeGreaterThan(0);
  });

  it("hides another user's archive (NOT_FOUND) and an archive after access is lost", async () => {
    const id = (await mod.request(customer, { orderId, stageKey: "design" })).archiveId;
    expect(await reason(mod.status(admin, id))).toBe("ARCHIVE_NOT_FOUND");
    readable.delete(customer.userId);
    expect(await reason(mod.status(customer, id))).toBe("ARCHIVE_NOT_FOUND");
    expect(await mod.latest(customer, { orderId, stageKey: "design" })).toBeNull();
  });
});

describe("build and download", () => {
  it("builds a verified ZIP and downloads it once per ticket", async () => {
    const id = await buildReady(admin, null);
    expect((await mod.status(admin, id)).state).toBe("ready");
    const { ticket } = await mod.issueDownloadTicket(admin, id);
    const dl = await mod.redeemDownloadTicket(admin, ticket);
    const entries = await readZip(await drain(dl.stream));
    expect([...entries.keys()].sort()).toEqual(["Order files/notes.txt", "design/Plan (2).PDF", "design/plan.pdf"].sort());
    expect(entries.get("design/plan.pdf")?.toString()).toBe("alpha");
    expect(await reason(mod.redeemDownloadTicket(admin, ticket))).toBe("DOWNLOAD_TICKET_INVALID");
  });

  it("fails the build when bytes do not match the manifest hash", async () => {
    const view = await mod.request(customer, { orderId, stageKey: "design" });
    files[0]!.bytes = Buffer.from("tampr");
    await h.jobs.runAll(ARCHIVE_BUILD_JOB);
    const status = await mod.status(customer, view.archiveId);
    expect(status.state).toBe("failed");
  });

  it("fails the build when the requesting session ended", async () => {
    const view = await mod.request(customer, { orderId, stageKey: "design" });
    liveSessions.delete(customer.sessionId);
    await h.jobs.runAll(ARCHIVE_BUILD_JOB);
    liveSessions.add(customer.sessionId);
    expect((await mod.status(customer, view.archiveId)).state).toBe("failed");
  });

  it("refuses another session's ticket without burning it, and refuses expired tickets", async () => {
    const id = await buildReady(customer);
    const { ticket } = await mod.issueDownloadTicket(customer, id);
    const otherSession = { ...customer, sessionId: "sess_other_example" };
    liveSessions.add(otherSession.sessionId);
    expect(await reason(mod.redeemDownloadTicket(otherSession, ticket))).toBe("DOWNLOAD_TICKET_INVALID");
    const ok = await mod.redeemDownloadTicket(customer, ticket);
    ok.stream.destroy();
    const second = await mod.issueDownloadTicket(customer, id);
    h.clock.advance(ARCHIVE_LIMITS.ticketMs + 1);
    expect(await reason(mod.redeemDownloadTicket(customer, second.ticket))).toBe("DOWNLOAD_TICKET_INVALID");
  });

  it("revokes the archive when the files change before download", async () => {
    const id = await buildReady(customer);
    const { ticket } = await mod.issueDownloadTicket(customer, id);
    files.push(file("late.pdf", "delta"));
    expect(await reason(mod.redeemDownloadTicket(customer, ticket))).toBe("ARCHIVE_STALE");
    expect((await mod.status(customer, id)).state).toBe("revoked");
  });

  it("expires archives after 30 minutes and frees the slot", async () => {
    const id = await buildReady(customer);
    h.clock.advance(ARCHIVE_LIMITS.ttlMs + 1);
    expect(await mod.expire()).toBe(1);
    expect((await mod.status(customer, id)).state).toBe("expired");
    expect(h.storage.objects.size).toBe(0);
  });
});
