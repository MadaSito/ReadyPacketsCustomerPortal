/**
 * D8 archives against LOCAL FAKES and the local dev MySQL test database: entry names, caps, slot reuse, order-scope
 * re-authorisation, build verification, ticket semantics and stale-download revocation. Synthetic data only.
 */
import { PassThrough, Readable } from "node:stream";
import { createHash } from "node:crypto";
import yauzl from "yauzl";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { sendPrivateDownload } from "../../http/downloads.js";
import { createIdentityModule, type IdentityModule } from "../identity/index.js";
import { customerRefHistory, customerRefReservations, identityTokens, sessionRestrictions, signInEvents, users, userSessions } from "../identity/schema.js";
import { orders } from "../orders/schema.js";
import { archiveDownloadName, archiveEntryNames, isSafeEntryName, sanitiseSegment } from "./archiveNames.js";
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
    publicId: orderId, reference: "RP-2026-000013", projectName: "Synthetic order", ownerUserId: Number((user as { insertId: number }).insertId),
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
      principalForJob: async (sessionId: string, userId: number) => {
        const p = principals.get(sessionId);
        if (!p || p.userId !== userId || !liveSessions.has(sessionId)) throw new DomainError("UNAUTHENTICATED", "SESSION_NOT_CURRENT", "Signed out.");
        return p;
      },
      getState: async (sessionId: string) => {
        const p = principals.get(sessionId);
        return p ? { sessionId, userId: p.userId, userPublicId: p.userPublicId, role: p.role, userStatus: "active", live: liveSessions.has(sessionId),
          revokedAt: null, mfaVerifiedAt: p.mfaVerifiedAt, stepUpAt: p.stepUpAt, authMethod: p.authMethod } : null;
      },
    },
    transitions: { derive: async () => [] },
  } as never;
  h.services.orders = { stages: { listForOrder: async () => ({
    stages: [{ key: "design", customerLabel: "Phase 1 Intake", staffLabel: "Internal design", viewable: true }],
  }) } } as never;
  mod = createFileArchivesModule(h.deps);
});

async function buildReady(p: SessionPrincipal, stageKey: string | null = "design") {
  const view = await mod.request(p, { orderId, stageKey });
  await h.jobs.runAll(ARCHIVE_BUILD_JOB);
  return (await mod.status(p, view.archiveId)).archiveId;
}

describe("entry names", () => {
  it("sanitises and bounds download names while keeping the reference, label slug and ZIP extension", () => {
    expect(archiveDownloadName("RP-2026-000013", "internal_key", "Fáse / Intake")).toBe("RP-2026-000013-fase-intake.zip");
    expect(archiveDownloadName("..\r\n/RP-2026-000013", null)).toBe("RP-2026-000013-all-files.zip");
    expect(archiveDownloadName("RP-2026-000013", "phase_1", "☃")).toBe("RP-2026-000013-phase-1.zip");
    const long = archiveDownloadName("RP-2026-000013", "phase_1", "a".repeat(200));
    expect(long).toHaveLength(120);
    expect(long).toMatch(/^RP-2026-000013-[a-z]+\.zip$/u);
  });

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

  it.each(["queued", "building"] as const)("resumes a %s job without re-snapshotting changed files", async (state) => {
    const a = await mod.request(customer, { orderId, stageKey: "design" });
    await db.db.update(fileArchives).set({ state }).where(eq(fileArchives.publicId, a.archiveId));
    files.push(file("late.pdf", "delta"));
    const b = await mod.request(customer, { orderId, stageKey: "design" });
    expect(b).toMatchObject({ archiveId: a.archiveId, state, fileCount: 2, expiresAt: a.expiresAt });
    expect(h.jobs.enqueued).toHaveLength(1);
  });

  it("reuses a matching ready archive and issues fresh single-use tickets without incrementing on issue", async () => {
    const id = await buildReady(customer);
    const abandoned = await mod.issueDownloadTicket(customer, id);
    expect(await mod.request(customer, { orderId, stageKey: "design" })).toMatchObject({ archiveId: id, state: "ready", downloadCount: 0 });
    const retry = await mod.issueDownloadTicket(customer, id);
    expect(retry.ticket).not.toBe(abandoned.ticket);
    expect((await mod.status(customer, id)).downloadCount).toBe(0);
    await drain((await mod.redeemDownloadTicket(customer, retry.ticket)).stream);
    expect(await reason(mod.redeemDownloadTicket(customer, retry.ticket))).toBe("DOWNLOAD_TICKET_INVALID");
    expect(await mod.request(customer, { orderId, stageKey: "design" })).toMatchObject({ archiveId: id, state: "ready", downloadCount: 1 });
    expect(h.audit.named("file.archive.requested")).toHaveLength(1);
    expect(h.audit.named("file.archive.ticket_issued")).toHaveLength(2);
    expect(h.audit.named("file.archive.downloaded")).toHaveLength(1);
    expect(h.jobs.enqueued).toHaveLength(0);
  });

  it("revokes and rebuilds a stale ready archive under the same scope", async () => {
    const id = await buildReady(customer);
    const old = await mod.issueDownloadTicket(customer, id);
    files.push(file("late.pdf", "delta"));
    const replacement = await mod.request(customer, { orderId, stageKey: "design" });
    expect(replacement.archiveId).not.toBe(id);
    expect(replacement).toMatchObject({ state: "queued", fileCount: 3, downloadCount: 0 });
    expect(await mod.status(customer, id)).toMatchObject({ state: "revoked", reasonCode: "ARCHIVE_STALE" });
    expect(h.storage.objects.size).toBe(0);
    expect(await reason(mod.redeemDownloadTicket(customer, old.ticket))).toBe("ARCHIVE_NOT_READY");
    expect(h.audit.named("file.archive.revoked")).toMatchObject([{ reasonCode: "ARCHIVE_STALE", resource: { publicId: id } }]);
    await h.jobs.runAll(ARCHIVE_BUILD_JOB);
    expect(await mod.status(customer, replacement.archiveId)).toMatchObject({ state: "ready" });
  });

  it("releases a stale ready ZIP when all files have been removed", async () => {
    const id = await buildReady(customer);
    files = [];
    expect(await reason(mod.request(customer, { orderId, stageKey: "design" }))).toBe("ARCHIVE_EMPTY");
    expect(await mod.status(customer, id)).toMatchObject({ state: "revoked", reasonCode: "ARCHIVE_STALE" });
    expect(h.storage.objects.size).toBe(0);
  });

  it("supersedes a different scope only after validating the new request and leaves one active ZIP", async () => {
    const first = await mod.request(customer, { orderId, stageKey: "design" });
    expect(await reason(mod.request(customer, { orderId, stageKey: null }))).toBe("CAPABILITY_NOT_GRANTED");
    expect(await reason(mod.request(customer, { orderId, stageKey: "empty" }))).toBe("ARCHIVE_EMPTY");
    expect(await mod.status(customer, first.archiveId)).toMatchObject({ state: "queued" });
    files.push(file("review.pdf", "delta", "review"));
    const replacement = await mod.request(customer, { orderId, stageKey: "review" });
    expect(await mod.status(customer, first.archiveId)).toMatchObject({ state: "revoked", reasonCode: "ARCHIVE_SUPERSEDED" });
    expect(h.audit.named("file.archive.revoked")).toMatchObject([{ reasonCode: "ARCHIVE_SUPERSEDED" }]);
    await h.jobs.runAll(ARCHIVE_BUILD_JOB);
    expect(await mod.status(customer, first.archiveId)).toMatchObject({ state: "revoked", reasonCode: "ARCHIVE_SUPERSEDED" });
    expect(await mod.status(customer, replacement.archiveId)).toMatchObject({ state: "ready" });
    expect(await db.db.select().from(fileArchives).where(eq(fileArchives.activeUserId, customer.userId))).toHaveLength(1);
  });

  it("does not let an in-flight superseded worker publish a ZIP or overwrite its revocation", async () => {
    const first = await mod.request(customer, { orderId, stageKey: "design" });
    const filesPort = h.services.files!;
    const open = filesPort.openDeliverableFile;
    let notifyStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const unblocked = new Promise<void>((resolve) => { release = resolve; });
    filesPort.openDeliverableFile = async (...args) => {
      notifyStarted();
      await unblocked;
      return open(...args);
    };
    const building = mod.build(first.archiveId);
    await started;
    try {
      files.push(file("review.pdf", "delta", "review"));
      await mod.request(customer, { orderId, stageKey: "review" });
    } finally {
      release();
    }
    expect(await building).toBe("revoked");
    expect(await mod.status(customer, first.archiveId)).toMatchObject({ state: "revoked", reasonCode: "ARCHIVE_SUPERSEDED" });
    expect(h.storage.objects.size).toBe(0);
    expect(h.audit.named("file.archive.built")).toHaveLength(0);
  });

  it("starts a new build for the same account in a new session without transferring old tickets", async () => {
    const id = await buildReady(customer);
    const old = await mod.issueDownloadTicket(customer, id);
    const other = { ...customer, sessionId: "sess_reopened_example" };
    liveSessions.add(other.sessionId);
    const replacement = await mod.request(other, { orderId, stageKey: "design" });
    expect(replacement).toMatchObject({ state: "queued" });
    expect(replacement.archiveId).not.toBe(id);
    expect(await mod.status(other, id)).toMatchObject({ state: "revoked", reasonCode: "ARCHIVE_SESSION_CHANGED" });
    expect(await reason(mod.redeemDownloadTicket(other, old.ticket))).toBe("DOWNLOAD_TICKET_INVALID");
    expect(await reason(mod.redeemDownloadTicket(customer, old.ticket))).toBe("ARCHIVE_NOT_READY");
  });

  it("whole-order ZIP needs admin and fresh step-up", async () => {
    expect(await reason(mod.request(customer, { orderId, stageKey: null }))).toBe("CAPABILITY_NOT_GRANTED");
    const id = await buildReady(admin, null);
    const stale = { ...admin, stepUpAt: new Date(h.clock.now().getTime() - 60 * 60_000) };
    expect(await reason(mod.request(stale, { orderId, stageKey: null }))).toBe("STEP_UP_REQUIRED");
    expect(await reason(mod.issueDownloadTicket(stale, id))).toBe("STEP_UP_REQUIRED");
    expect(await mod.request(admin, { orderId, stageKey: null })).toMatchObject({ archiveId: id, state: "ready" });
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
    expect(dl.filename).toBe("RP-2026-000013-all-files.zip");
    const entries = await readZip(await drain(dl.stream));
    expect([...entries.keys()].sort()).toEqual(["Order files/notes.txt", "design/Plan (2).PDF", "design/plan.pdf"].sort());
    expect(entries.get("design/plan.pdf")?.toString()).toBe("alpha");
    expect(await reason(mod.redeemDownloadTicket(admin, ticket))).toBe("DOWNLOAD_TICKET_INVALID");
  });

  it("sets both Content-Disposition names from the authorised phase's customer label", async () => {
    const id = await buildReady(customer);
    const { ticket } = await mod.issueDownloadTicket(customer, id);
    const download = await mod.redeemDownloadTicket(customer, ticket);
    expect(download.filename).toBe("RP-2026-000013-phase-1-intake.zip");
    const headers = new Map<string, string | number>();
    const output = Object.assign(new PassThrough(), { setHeader: (name: string, value: string | number) => headers.set(name, value) });
    output.resume();
    await sendPrivateDownload(output as unknown as Parameters<typeof sendPrivateDownload>[0], { ...download, contentType: "application/zip" });
    expect(headers.get("Content-Disposition")).toBe("attachment; filename=\"RP-2026-000013-phase-1-intake.zip\"; filename*=UTF-8''RP-2026-000013-phase-1-intake.zip");
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

/* Real Identity sessions: the build job must rebuild a principal that Identity's assertCurrent accepts (the Files
 * selector checks it on every list/open). The Files port here is a fake that calls the REAL assertCurrent. */
describe("build with real Identity sessions", () => {
  const PW = "copper lantern drifts beyond quiet harbor";
  let rdb: TestDb;
  let rh: TestHarness;
  let identity: IdentityModule;
  let archivesMod: FileArchivesModule;
  let rOrderId: string;
  let seq = 0;
  const content = [file("brief.pdf", "alpha"), file("plan.pdf", "beta", null)];

  async function account(role: "customer" | "admin") {
    seq += 1;
    const email = `zip${seq}.${Date.now().toString(36)}@example.test`;
    const created = await rdb.db.transaction((tx) => identity.auth.insertUser(tx as Tx, {
      email, name: `Synthetic Zip${seq}`, role, status: "active", origin: "test", emailVerifiedAt: rh.clock.now(),
    }));
    await identity.setPassword(created.id, PW, { mustChange: false });
    return { ...created, email };
  }
  async function signedIn(email: string, stepUp = false): Promise<SessionPrincipal> {
    const signed = await identity.auth.signIn({ email, password: PW }, { userAgent: "vitest" });
    let issued = await identity.sessions.markMfaVerified(signed.sessionId);
    if (stepUp) issued = await identity.sessions.markStepUp(signed.sessionId);
    const principal = await identity.sessionResolver.resolve({ token: issued.token, transport: "cookie" });
    expect(principal?.state).toBe("full");
    return principal!;
  }

  beforeAll(async () => {
    rdb = await createTestDb({ schema: { users, userSessions, identityTokens, customerRefReservations, customerRefHistory, signInEvents, sessionRestrictions, orders, fileArchives, fileArchiveTickets } });
  });
  afterAll(() => rdb?.cleanup());

  beforeEach(async () => {
    rh = createTestDeps({ db: rdb.db });
    rh.services.assurance = {
      getAssuranceState: async () => ({ mfaEnrolled: true, recoveryCodesAcknowledged: true, passkeyCount: 0, totpEnrolled: true }),
      lockLocalAdministratorPolicy: async () => {},
      assertLocalAdministratorMayLoseAccess: async () => {},
    } as never;
    identity = createIdentityModule(rh.deps);
    rh.services.identity = identity;
    const owner = await account("customer");
    rOrderId = ulid();
    await rdb.db.insert(orders).values({
      publicId: rOrderId, reference: rOrderId, projectName: "Synthetic order", ownerUserId: owner.id,
      workflowVersionId: 1, statusKey: "intake", subtotalMinor: 0, totalMinor: 0, currency: "USD",
    } as never);
    const current = async (p: SessionPrincipal, tx?: Tx) => {
      if (tx) await identity.sessions.assertCurrent(p, tx);
      else await rdb.db.transaction((t) => identity.sessions.assertCurrent(p, t as Tx));
    };
    rh.services.files = {
      async listDeliverableFiles(p: SessionPrincipal, scope: { stageKey?: string }, tx?: Tx) {
        await current(p, tx);
        return { items: content.filter((f) => !scope.stageKey || f.stageKey === scope.stageKey).map(({ bytes: _b, ...rest }) => rest), nextCursor: null };
      },
      async openDeliverableFile(p: SessionPrincipal, scope: { filePublicId: string }, tx?: Tx) {
        await current(p, tx);
        const f = content.find((x) => x.publicId === scope.filePublicId)!;
        const { bytes, ...rest } = f;
        return { file: rest, stream: Readable.from([bytes]) };
      },
    } as never;
    archivesMod = createFileArchivesModule(rh.deps);
    (rh as unknown as { owner: typeof owner }).owner = owner;
  });

  it("builds a phase ZIP for the signed-in customer and downloads it", async () => {
    const owner = (rh as unknown as { owner: { email: string } }).owner;
    const customerSession = await signedIn(owner.email);
    const view = await archivesMod.request(customerSession, { orderId: rOrderId, stageKey: "design" });
    await rh.jobs.runAll(ARCHIVE_BUILD_JOB);
    expect((await archivesMod.status(customerSession, view.archiveId)).state).toBe("ready");
    const { ticket } = await archivesMod.issueDownloadTicket(customerSession, view.archiveId);
    const dl = await archivesMod.redeemDownloadTicket(customerSession, ticket);
    expect([...(await readZip(await drain(dl.stream))).keys()]).toEqual(["brief.pdf"]);
  });

  it("builds a whole-order ZIP for an administrator with a fresh step-up", async () => {
    const adminUser = await account("admin");
    const adminSession = await signedIn(adminUser.email, true);
    const view = await archivesMod.request(adminSession, { orderId: rOrderId, stageKey: null });
    await rh.jobs.runAll(ARCHIVE_BUILD_JOB);
    const status = await archivesMod.status(adminSession, view.archiveId);
    expect(status).toMatchObject({ state: "ready", scope: "order", fileCount: 2 });
  });

  it("fails the build with ARCHIVE_SESSION_ENDED when the requesting session is revoked", async () => {
    const owner = (rh as unknown as { owner: { email: string } }).owner;
    const customerSession = await signedIn(owner.email);
    const view = await archivesMod.request(customerSession, { orderId: rOrderId, stageKey: "design" });
    await identity.sessions.revoke(customerSession.sessionId, "test_revoked");
    await rh.jobs.runAll(ARCHIVE_BUILD_JOB);
    const [row] = await rdb.db.select().from(fileArchives).where(eq(fileArchives.publicId, view.archiveId));
    expect(row).toMatchObject({ state: "failed", reasonCode: "ARCHIVE_SESSION_ENDED" });
    expect(rh.storage.objects.size).toBe(0);
  });
});
