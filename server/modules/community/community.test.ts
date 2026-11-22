import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDeps, fakePrincipal, type TestHarness } from "../../../tests/helpers/fakes.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import type { UserRole } from "../../../shared/domain.js";
import type { Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { Db, SessionPrincipal, Tx } from "../../core/types.js";
import { createCallerFactory, router, type TrpcContext } from "../../trpc/trpc.js";
import { users } from "../identity/schema.js";
import { platformSettings } from "../platform/schema.js";
import { createSettingsStore } from "../platform/settingsStore.js";
import { TRIGGER_CATALOGUE } from "../audit/triggerCatalogue.js";
import { createCommunityModule, type CommunityModule } from "./index.js";
import { communityRouter } from "./router.js";
import * as tables from "./schema.js";
import { DEFAULT_COMMUNITY_CONFIG } from "./settings.js";
import { likePattern } from "./service.js";
import { countLinks, matchWordList, normaliseBody, validateDisplayName } from "./text.js";

const createCaller = createCallerFactory(router({ community: communityRouter }));

interface U {
  id: number;
  principal: SessionPrincipal;
}

let seq = 0;
let keySeq = 0;
const key = () => `idem_${++keySeq}_abcdefgh`;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof DomainError) return `${e.code}:${e.reasonCode}`;
    const c = (e as { code?: string; cause?: unknown }).cause;
    if (c instanceof DomainError) return `${c.code}:${c.reasonCode}`;
    return `ERR:${(e as { code?: string }).code ?? String(e)}`;
  }
}

describe("community forum (package M)", () => {
  let tdb: TestDb;
  let h: TestHarness;
  let community: CommunityModule;
  const notified: { userId: number; kind: string; link?: string | null; title: string; body: string }[] = [];
  let admin: U, staff: U, alice: U, bob: U, carol: U, newbie: U;
  let general: string;

  async function user(role: UserRole, opts: { ageDays?: number } = {}): Promise<U> {
    seq += 1;
    const publicId = ulid(h.clock.now().getTime() + seq);
    const email = `community.${seq}@synthetic.test`;
    await tdb.db.insert(users).values({
      publicId,
      role,
      status: "active",
      emailEnc: h.deps.crypto.encrypt(email, `users.email:${publicId}`),
      emailIndex: h.deps.crypto.blindIndex(email, "users.email"),
      emailVerifiedAt: h.clock.now(),
      nameEnc: h.deps.crypto.encrypt(`Synthetic ${seq}`, `users.name:${publicId}`),
      createdAt: new Date(h.clock.now().getTime() - (opts.ageDays ?? 60) * 86_400_000),
    });
    const [row] = await tdb.db.select({ id: users.id }).from(users).where(eq(users.publicId, publicId));
    return { id: row!.id, principal: fakePrincipal({ userId: row!.id, userPublicId: publicId, role, stepUpAt: h.clock.now() }) };
  }

  const caller = (s: SessionPrincipal | null) =>
    createCaller({ services: h.services, session: s && s.stepUpAt ? { ...s, stepUpAt: h.clock.now() } : s, request: newRequestContext("test"), transport: { issue() {}, clear() {} } } satisfies TrpcContext);

  async function setConfig(patch: Partial<typeof DEFAULT_COMMUNITY_CONFIG>) {
    await community.updateSettings(admin.principal, { ...DEFAULT_COMMUNITY_CONFIG, ...patch });
  }

  beforeAll(async () => {
    tdb = await createTestDb({ schema: { users, platformSettings, ...tables } });
    h = createTestDeps({ db: tdb.db });
    h.deps.settings = createSettingsStore({ db: tdb.db, clock: h.clock, logger: h.deps.logger, crypto: h.deps.crypto, audit: h.audit });
    h.services.settings = h.deps.settings;
    h.services.identity = {
      sessions: {
        assertCurrent: async (p: SessionPrincipal, tx: Tx) => {
          const [u] = await tx.select().from(users).where(eq(users.id, p.userId)).limit(1);
          if (!u || u.status !== "active" || u.role !== p.role) throw new DomainError("UNAUTHENTICATED", "SESSION_NOT_CURRENT", "Sign in again.");
          return { pendingSteps: [], role: u.role, stepUpAt: p.stepUpAt, mfaVerifiedAt: p.mfaVerifiedAt };
        },
      },
    } as unknown as Services["identity"];
    h.services.engagement = {
      notify: async (input: { userId: number; kind: string; link?: string | null; title: string; body: string }) => {
        notified.push(input);
        return { created: true };
      },
    } as unknown as Services["engagement"];
    community = createCommunityModule(h.deps);
    (h.services as unknown as { community: CommunityModule }).community = community;

    admin = await user("admin");
    staff = await user("staff");
    alice = await user("customer");
    bob = await user("customer");
    carol = await user("customer");
    newbie = await user("customer", { ageDays: 1 });
  });
  afterAll(() => tdb.cleanup());
  beforeEach(() => {
    notified.length = 0;
    h.clock.advance(60 * 60 * 1000);
  });

  describe("text rules", () => {
    it("normalises bodies and strips controls and bidi overrides", () => {
      expect(normaliseBody("  hi\r\n\r\n\r\n\r\nthere\u202E\u0007 ")).toBe("hi\n\nthere");
      expect(() => normaliseBody(" \n ")).toThrow(DomainError);
      expect(() => normaliseBody("x".repeat(10_001))).toThrow(DomainError);
    });
    it("validates display names: not e-mail-like, not reserved, no long numbers", () => {
      expect(validateDisplayName("  River  Stone ").displayName).toBe("River Stone");
      for (const bad of ["ab", "me@example.test", "shop.com", "Admin", "Official_Support", "caller 5551234567", "<b>x</b>"]) {
        expect(() => validateDisplayName(bad), bad).toThrow(DomainError);
      }
    });
    it("matches word lists by whole word or phrase, case-folded, without regular expressions", () => {
      expect(matchWordList("Buy CHEAP pills now", ["cheap pills"])).toBe("cheap pills");
      expect(matchWordList("cheapest", ["cheap"])).toBeNull();
      expect(matchWordList("a".repeat(5000), ["(a+)+$"])).toBeNull();
      expect(countLinks("see https://a.test and www.b.test or ftp://c")).toBe(2);
      expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
    });
  });

  describe("enable switch", () => {
    it("is off by default and every member procedure is NOT_FOUND while off", async () => {
      expect(await community.enabled()).toBe(false);
      expect((await caller(alice.principal).community.status()).enabled).toBe(false);
      expect(await code(caller(alice.principal).community.categories.list())).toBe("NOT_FOUND:COMMUNITY_DISABLED");
      expect(await code(caller(staff.principal).community.mod.queue())).toBe("NOT_FOUND:COMMUNITY_DISABLED");
      expect(await code(caller(alice.principal).community.profile.save({ displayName: "Alice Reader" }))).toBe("NOT_FOUND:COMMUNITY_DISABLED");
    });

    it("only administrators with community.manage can switch it on, and the change is audited", async () => {
      expect(await code(caller(null).community.admin.setEnabled({ enabled: true }))).toMatch(/^UNAUTHENTICATED/u);
      expect(await code(caller(alice.principal).community.admin.setEnabled({ enabled: true }))).toBe("FORBIDDEN:ROLE_NOT_PERMITTED");
      expect(await code(caller(staff.principal).community.admin.setEnabled({ enabled: true }))).toBe("FORBIDDEN:ROLE_NOT_PERMITTED");
      const noStepUp = { ...admin.principal, stepUpAt: null };
      expect(await code(caller(noStepUp).community.admin.setEnabled({ enabled: true }))).toBe("STEP_UP_REQUIRED:STEP_UP_REQUIRED");
      h.audit.events.length = 0;
      await caller(admin.principal).community.admin.setEnabled({ enabled: true });
      expect(await community.enabled()).toBe(true);
      const ev = h.audit.events.find((e) => e.eventName === "community.enabled.changed");
      expect(ev?.attributes).toEqual({ enabled: true, previous: false });
      expect(h.audit.recordedInTx.at(-1)).toBe(true);

      const cat = await caller(admin.principal).community.admin.categories.create({ slug: "general", name: "General questions" });
      general = cat.publicId;
    });
  });

  describe("profiles", () => {
    it("requires a display name before posting and keeps names unique case-insensitively", async () => {
      expect(await code(community.createTopic(alice.principal, { categoryPublicId: general, title: "Hello there", body: "First", idempotencyKey: key() }))).toBe("VALIDATION:COMMUNITY_PROFILE_REQUIRED");
      await caller(alice.principal).community.profile.save({ displayName: "Alice Reader" });
      expect(await code(caller(bob.principal).community.profile.save({ displayName: "alice  reader" }))).toBe("CONFLICT:COMMUNITY_NAME_TAKEN");
      await caller(bob.principal).community.profile.save({ displayName: "Bob Builder" });
      await caller(carol.principal).community.profile.save({ displayName: "Carol C" });
      await caller(newbie.principal).community.profile.save({ displayName: "New Person" });
      await caller(staff.principal).community.profile.save({ displayName: "Sam Helps" });
      const status = await caller(alice.principal).community.status();
      expect(status.profile?.displayName).toBe("Alice Reader");
      expect(JSON.stringify(h.audit.events)).not.toMatch(/Alice Reader|Bob Builder|synthetic\.test/u);
    });
  });

  describe("topics, replies and notifications", () => {
    let topic: string;
    let opening: string;
    it("publishes an established member's topic and notifies subscribers on reply without post text", async () => {
      const r = await caller(alice.principal).community.topics.create({ categoryPublicId: general, title: "Packet tips", body: "What helps?\n\n> quoted\n- item https://example.test/x", idempotencyKey: key() });
      expect(r.state).toBe("published");
      topic = r.topicPublicId;
      opening = r.postPublicId;
      const reply = await caller(bob.principal).community.posts.reply({ topicPublicId: topic, body: "Use the checklist.", quotePostPublicId: opening, idempotencyKey: key() });
      expect(reply.state).toBe("published");
      expect(notified.map((n) => n.userId)).toEqual([alice.id]);
      expect(notified[0]).toMatchObject({ kind: "community.reply", link: `/community/t/${topic}` });
      expect(JSON.stringify(notified)).not.toMatch(/checklist/u);
      const detail = await caller(carol.principal).community.topics.get({ topicPublicId: topic });
      expect(detail.posts).toHaveLength(2);
      expect(detail.posts[1]!.quote?.author).toBe("Alice Reader");
      expect(detail.posts[0]!.author).toEqual({ publicId: expect.any(String), displayName: "Alice Reader", staff: false });
      expect(JSON.stringify(detail)).not.toMatch(/synthetic\.test|Synthetic \d/u);
      expect(detail.topic.replyCount).toBe(1);
    });

    it("is idempotent per author and key", async () => {
      const k = key();
      const a = await community.reply(carol.principal, { topicPublicId: topic, body: "Same request", idempotencyKey: k });
      const b = await community.reply(carol.principal, { topicPublicId: topic, body: "Same request", idempotencyKey: k });
      expect(b.postPublicId).toBe(a.postPublicId);
    });

    it("lets the author edit within the window with optimistic versioning, then refuses", async () => {
      const fresh = await community.reply(alice.principal, { topicPublicId: topic, body: "Edit me", idempotencyKey: key() });
      const detail = await community.getTopic(alice.principal, { topicPublicId: topic });
      const mine = detail.posts.find((x) => x.publicId === fresh.postPublicId)!;
      expect(mine.canEdit).toBe(true);
      expect(await code(community.editPost(bob.principal, { postPublicId: mine.publicId, body: "hijack", expectedVersion: mine.version }))).toBe("FORBIDDEN:COMMUNITY_NOT_AUTHOR");
      await community.editPost(alice.principal, { postPublicId: mine.publicId, body: "What helps most?", expectedVersion: mine.version });
      expect(await code(community.editPost(alice.principal, { postPublicId: mine.publicId, body: "stale", expectedVersion: mine.version }))).toBe("CONFLICT:STALE_VERSION");
      h.clock.advance(31 * 60_000);
      expect(await code(community.editPost(alice.principal, { postPublicId: mine.publicId, body: "late", expectedVersion: mine.version + 1 }))).toBe("CONFLICT:COMMUNITY_EDIT_WINDOW_CLOSED");
    });

    it("marks helpful once per member, never on one's own post", async () => {
      const r1 = await community.react(carol.principal, { postPublicId: opening, helpful: true });
      const r2 = await community.react(carol.principal, { postPublicId: opening, helpful: true });
      expect(r1.helpfulCount).toBe(1);
      expect(r2.helpfulCount).toBe(1);
      expect(await code(community.react(alice.principal, { postPublicId: opening, helpful: true }))).toBe("VALIDATION:COMMUNITY_OWN_POST");
    });

    it("refuses replies to locked topics and topics in archived categories (archive is read-only)", async () => {
      await community.moderateTopic(staff.principal, { topicPublicId: topic, action: "lock" });
      expect(await code(community.reply(bob.principal, { topicPublicId: topic, body: "after lock", idempotencyKey: key() }))).toBe("CONFLICT:COMMUNITY_TOPIC_LOCKED");
      await community.moderateTopic(staff.principal, { topicPublicId: topic, action: "unlock" });
      const cat = (await community.getSettings(admin.principal)).categories.find((c) => c.publicId === general)!;
      await community.updateCategory(admin.principal, { categoryPublicId: general, expectedVersion: cat.version, archived: true });
      expect(await code(community.reply(bob.principal, { topicPublicId: topic, body: "after archive", idempotencyKey: key() }))).toBe("CONFLICT:COMMUNITY_CATEGORY_ARCHIVED");
      expect(await code(community.createTopic(bob.principal, { categoryPublicId: general, title: "Archived?", body: "x", idempotencyKey: key() }))).toBe("CONFLICT:COMMUNITY_CATEGORY_ARCHIVED");
      expect((await community.getTopic(carol.principal, { topicPublicId: topic })).posts.length).toBeGreaterThan(0);
      expect((await community.listTopics(carol.principal, { categoryPublicId: general })).items.length).toBeGreaterThan(0);
      await community.updateCategory(admin.principal, { categoryPublicId: general, expectedVersion: cat.version + 1, archived: false });
    });
  });

  describe("forum spam abuse (§4)", () => {
    it("holds a new member's first posts for review and hides them from others", async () => {
      const r = await community.createTopic(newbie.principal, { categoryPublicId: general, title: "Great offer", body: "hello all", idempotencyKey: key() });
      expect(r.state).toBe("pending");
      expect(await code(community.getTopic(alice.principal, { topicPublicId: r.topicPublicId }))).toBe("NOT_FOUND:NOT_FOUND");
      expect((await community.getTopic(newbie.principal, { topicPublicId: r.topicPublicId })).posts[0]!.state).toBe("pending");
      expect((await community.search(alice.principal, { q: "Great offer" })).items).toHaveLength(0);
      const q = await community.queue(staff.principal);
      expect(q.pending.some((p) => p.publicId === r.postPublicId && p.heldReason === "new_member")).toBe(true);
      await community.moderatePost(staff.principal, { postPublicId: r.postPublicId, action: "approve" });
      expect((await community.getTopic(alice.principal, { topicPublicId: r.topicPublicId })).posts[0]!.body).toBe("hello all");
    });

    it("limits a new member's daily posts and refuses duplicates", async () => {
      await setConfig({ newMemberDailyPosts: 3, newMemberReviewPosts: 0 });
      const t = await community.listTopics(newbie.principal, {});
      const topic = t.items.find((i) => i.title === "Great offer")!.publicId;
      await community.reply(newbie.principal, { topicPublicId: topic, body: "one", idempotencyKey: key() });
      expect(await code(community.reply(newbie.principal, { topicPublicId: topic, body: "ONE ", idempotencyKey: key() }))).toBe("CONFLICT:COMMUNITY_DUPLICATE_POST");
      await community.reply(newbie.principal, { topicPublicId: topic, body: "two", idempotencyKey: key() });
      expect(await code(community.reply(newbie.principal, { topicPublicId: topic, body: "three", idempotencyKey: key() }))).toBe("RATE_LIMITED:COMMUNITY_NEW_MEMBER_LIMIT");
      await setConfig({});
    });

    it("applies the hourly limit to everyone except staff", async () => {
      await setConfig({ maxPostsPerHour: 2 });
      const r = await community.createTopic(bob.principal, { categoryPublicId: general, title: "Rate topic", body: "r0", idempotencyKey: key() });
      await community.reply(bob.principal, { topicPublicId: r.topicPublicId, body: "r1", idempotencyKey: key() });
      expect(await code(community.reply(bob.principal, { topicPublicId: r.topicPublicId, body: "r2", idempotencyKey: key() }))).toBe("RATE_LIMITED:COMMUNITY_HOURLY_LIMIT");
      for (let i = 0; i < 3; i += 1) await community.reply(staff.principal, { topicPublicId: r.topicPublicId, body: `staff ${i}`, idempotencyKey: key() });
      await setConfig({});
    });

    it("refuses blocked words and holds held words and link-heavy new-member posts", async () => {
      await setConfig({ blockedWords: ["casino bonus"], heldWords: ["crypto"], newMemberReviewPosts: 0 });
      const r = await community.createTopic(carol.principal, { categoryPublicId: general, title: "Filter topic", body: "fine", idempotencyKey: key() });
      expect(await code(community.reply(carol.principal, { topicPublicId: r.topicPublicId, body: "Free CASINO   bonus today", idempotencyKey: key() }))).toBe("VALIDATION:COMMUNITY_BLOCKED_WORD");
      expect((await community.reply(carol.principal, { topicPublicId: r.topicPublicId, body: "about crypto", idempotencyKey: key() })).state).toBe("pending");
      const links = "https://a.test https://b.test https://c.test https://d.test";
      h.clock.advance(2 * 86_400_000);
      expect((await community.reply(newbie.principal, { topicPublicId: r.topicPublicId, body: links, idempotencyKey: key() })).state).toBe("pending");
      await setConfig({});
    });

    it("holds an edit that pushes a published new-member post over the link threshold and hides the new body", async () => {
      await setConfig({ newMemberReviewPosts: 0 });
      const r = await community.createTopic(alice.principal, { categoryPublicId: general, title: "Edit links topic", body: "start", idempotencyKey: key() });
      const p = await community.reply(newbie.principal, { topicPublicId: r.topicPublicId, body: "harmless", idempotencyKey: key() });
      expect(p.state).toBe("published");
      const before = await community.getTopic(newbie.principal, { topicPublicId: r.topicPublicId });
      const mine = before.posts.find((x) => x.publicId === p.postPublicId)!;
      const edited = await community.editPost(newbie.principal, { postPublicId: p.postPublicId, body: "spamword https://a.test https://b.test https://c.test https://d.test", expectedVersion: mine.version });
      expect(edited.state).toBe("pending");
      const seen = await community.getTopic(alice.principal, { topicPublicId: r.topicPublicId });
      expect(seen.posts.find((x) => x.publicId === p.postPublicId)).toBeUndefined();
      expect(seen.topic.replyCount).toBe(0);
      expect((await community.search(alice.principal, { q: "spamword" })).items).toHaveLength(0);
      expect(await code(community.reply(alice.principal, { topicPublicId: r.topicPublicId, body: "quoting", quotePostPublicId: p.postPublicId, idempotencyKey: key() }))).toBe("NOT_FOUND:NOT_FOUND");
      await setConfig({});
    });

    it("hides a post automatically when enough distinct members report it; one open report per member", async () => {
      await setConfig({ autoHideReportCount: 2 });
      const r = await community.createTopic(bob.principal, { categoryPublicId: general, title: "Reported topic", body: "ok", idempotencyKey: key() });
      const bad = await community.reply(bob.principal, { topicPublicId: r.topicPublicId, body: "rude words", idempotencyKey: key() });
      expect(await code(community.report(bob.principal, { postPublicId: bad.postPublicId, reason: "abuse" }))).toBe("VALIDATION:COMMUNITY_OWN_POST");
      expect((await community.report(alice.principal, { postPublicId: bad.postPublicId, reason: "abuse", note: "Contact me at someone@example.test" })).postHidden).toBe(false);
      expect(await code(community.report(alice.principal, { postPublicId: bad.postPublicId, reason: "spam" }))).toBe("CONFLICT:COMMUNITY_ALREADY_REPORTED");
      expect((await community.report(carol.principal, { postPublicId: bad.postPublicId, reason: "abuse" })).postHidden).toBe(true);
      const view = await community.getTopic(alice.principal, { topicPublicId: r.topicPublicId });
      expect(view.posts.find((p) => p.publicId === bad.postPublicId)?.body).toBeNull();
      const reported = h.audit.events.filter((e) => e.eventName === "community.post.reported");
      expect(JSON.stringify(reported)).not.toMatch(/example\.test|rude/u);
      const q = await community.queue(staff.principal);
      const rep = q.reports.find((x) => x.postPublicId === bad.postPublicId)!;
      await community.resolveReport(staff.principal, { reportPublicId: rep.publicId, outcome: "actioned" });
      expect(await code(community.resolveReport(staff.principal, { reportPublicId: rep.publicId, outcome: "dismissed" }))).toBe("CONFLICT:COMMUNITY_REPORT_RESOLVED");
      await setConfig({});
    });

    it("suspends a member from posting; staff cannot suspend staff; everything is logged", async () => {
      const status = await community.status(bob.principal);
      const bobProfile = status.profile!.publicId;
      await community.suspend(staff.principal, { memberPublicId: bobProfile, days: 7, reason: "Repeated spam" });
      expect(await code(community.createTopic(bob.principal, { categoryPublicId: general, title: "While suspended", body: "x", idempotencyKey: key() }))).toBe("FORBIDDEN:COMMUNITY_SUSPENDED");
      expect((await community.status(bob.principal)).suspended).toBe(true);
      const staffProfile = (await community.status(staff.principal)).profile!.publicId;
      const otherStaff = await user("staff");
      await community.saveProfile(otherStaff.principal, { displayName: "Taylor Helper" });
      expect(await code(community.suspend(otherStaff.principal, { memberPublicId: staffProfile, days: 1, reason: "test" }))).toBe("FORBIDDEN:COMMUNITY_CANNOT_SUSPEND_STAFF");
      await community.unsuspend(staff.principal, { memberPublicId: bobProfile });
      const log = await community.moderationLog(staff.principal, {});
      expect(log.items.map((i) => i.action)).toEqual(expect.arrayContaining(["suspend", "unsuspend", "auto_hide", "report_actioned", "approve"]));
    });
  });

  describe("authorisation matrix", () => {
    it("anonymous / customer / other customer / staff / admin", async () => {
      const r = await community.createTopic(alice.principal, { categoryPublicId: general, title: "Matrix topic", body: "matrix", idempotencyKey: key() });
      const anon = caller(null).community;
      expect(await code(anon.status())).toMatch(/^UNAUTHENTICATED/u);
      expect(await code(anon.topics.get({ topicPublicId: r.topicPublicId }))).toMatch(/^UNAUTHENTICATED/u);
      // customer (author) and other customer: read yes, moderate no, edit only own
      expect(await code(caller(carol.principal).community.topics.get({ topicPublicId: r.topicPublicId }))).toBe("OK");
      expect(await code(caller(carol.principal).community.mod.queue())).toBe("FORBIDDEN:ROLE_NOT_PERMITTED");
      expect(await code(caller(carol.principal).community.mod.post({ postPublicId: r.postPublicId, action: "hide" }))).toBe("FORBIDDEN:ROLE_NOT_PERMITTED");
      expect(await code(caller(carol.principal).community.posts.delete({ postPublicId: r.postPublicId }))).toBe("FORBIDDEN:COMMUNITY_NOT_AUTHOR");
      expect(await code(caller(carol.principal).community.admin.settings.get())).toBe("FORBIDDEN:ROLE_NOT_PERMITTED");
      // staff: moderate yes, manage no
      expect(await code(caller(staff.principal).community.mod.queue())).toBe("OK");
      expect(await code(caller(staff.principal).community.admin.settings.get())).toBe("FORBIDDEN:ROLE_NOT_PERMITTED");
      // admin: both
      expect(await code(caller(admin.principal).community.admin.settings.get())).toBe("OK");
      expect(await code(caller(admin.principal).community.mod.post({ postPublicId: r.postPublicId, action: "hide", reason: "test" }))).toBe("OK");
      // hidden opening post: other customers see a placeholder, never the body
      const seen = await community.getTopic(carol.principal, { topicPublicId: r.topicPublicId }).catch(() => null);
      expect(seen === null || seen.posts[0]!.body === null).toBe(true);
      // stale role in the session is refused in-transaction
      const demoted = { ...staff.principal, role: "admin" as const };
      expect(await code(community.queue(demoted))).toMatch(/^UNAUTHENTICATED:SESSION_NOT_CURRENT/u);
      // ids are validated
      expect(await code(caller(carol.principal).community.topics.get({ topicPublicId: "1 OR 1=1" }))).toMatch(/^(?:ERR|VALIDATION|BAD_REQUEST)/u);
    });

    it("search escapes LIKE wildcards and only returns published content", async () => {
      expect((await community.search(carol.principal, { q: "%%" })).items).toHaveLength(0);
      expect((await community.search(carol.principal, { q: "Packet tips" })).items.map((i) => i.title)).toContain("Packet tips");
    });
  });

  describe("disable again", () => {
    it("hides everything again when switched off; the catalogue lists staff-only community triggers", async () => {
      await community.setEnabled(admin.principal, { enabled: false });
      expect(await code(community.listTopics(alice.principal, {}))).toBe("NOT_FOUND:COMMUNITY_DISABLED");
      const entries = TRIGGER_CATALOGUE.filter((e) => e.owner === "community");
      expect(entries.map((e) => e.key).sort()).toEqual(["community.post_reported", "community.topic_created"]);
      expect(entries.every((e) => e.staffOnly === true)).toBe(true);
    });
  });
});

export type { Db };
