/**
 * Cookie consent: settings, ledger and public bootstrap (increment 04, package J). Owner: platform engineer.
 *
 * - The ledger is append-only proof of each decision. It stores a random consent id (never derived from
 *   the person), the user's PUBLIC id when the decision came from a full session, the choices, action,
 *   source, the GPC flag and a keyed HMAC of the IP. No IP in clear and no user agent.
 * - The inventory is plain text only (no markup, no URLs as script sources); it is rendered as text.
 * - Everything is off until `feature.privacy.consent` is switched on (audited by the settings store).
 */
import { and, desc, eq, gte, lt, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { DomainError, conflict, validation } from "../../core/errors.js";
import type { AuditEmitter, Clock, Db, FieldCrypto, Logger, SettingsStore } from "../../core/types.js";
import { platformConsentRecords } from "./schema.js";
import { plainText } from "./settings.js";
import { defineFeatureFlag, defineSetting, isFlagEnabled, listSettingDefinitions, readSetting } from "./settingsRegistry.js";

/* ------------------------------------------------------------------ declarations */

export const CONSENT_CATEGORIES = ["necessary", "preferences", "analytics", "session_replay"] as const;
export type ConsentCategoryKey = (typeof CONSENT_CATEGORIES)[number];
export const CONSENT_ACTIONS = ["accept_all", "reject_all", "save", "withdraw"] as const;
export const CONSENT_SOURCES = ["banner", "preferences", "account", "gpc"] as const;
export type ConsentAction = (typeof CONSENT_ACTIONS)[number];
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export const CONSENT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MANAGED = { href: "/admin/privacy", label: "Cookies and consent" } as const;

export const CONSENT_FLAG = defineFeatureFlag({
  flag: "privacy.consent",
  owner: "platform",
  group: "privacy",
  label: "Cookie consent banner",
  description: "Shows the cookie banner and preference centre and records decisions. Optional tools never run without consent.",
  clientVisible: true,
});

export const CONSENT_POLICY_VERSION = defineSetting({
  key: "privacy.consent.policy_version",
  owner: "platform",
  group: "privacy",
  label: "Cookie policy version",
  description: "Raise it when the cookie policy or inventory changes materially; everyone is asked again.",
  schema: z.number().int().min(1).max(100_000),
  default: 1,
  sensitivity: "public",
  writeCapability: "privacy.consent.manage",
  managedBy: MANAGED,
});

export const CONSENT_RENEW_MONTHS = defineSetting({
  key: "privacy.consent.renew_months",
  owner: "platform",
  group: "privacy",
  label: "Ask again after (months)",
  description: "How long a choice is valid before the banner asks again (6 to 13 months).",
  schema: z.number().int().min(6).max(13),
  default: 12,
  sensitivity: "public",
  writeCapability: "privacy.consent.manage",
  managedBy: MANAGED,
});

const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/);
export const cookieItemSchema = z.strictObject({
  id: slug,
  name: plainText(80, { min: 1 }),
  provider: plainText(80, { min: 1 }),
  category: z.enum(CONSENT_CATEGORIES),
  storage: z.enum(["cookie", "local_storage", "session_storage", "none"]),
  firstParty: z.boolean(),
  purpose: plainText(400, { multiline: true, min: 1 }),
  duration: plainText(60, { min: 1 }),
});
export type CookieItem = z.infer<typeof cookieItemSchema>;
export const MAX_COOKIE_ITEMS = 100;

export const cookieInventorySchema = z
  .array(cookieItemSchema)
  .max(MAX_COOKIE_ITEMS)
  .refine((items) => new Set(items.map((i) => i.id)).size === items.length, "item ids must be unique");

export const DEFAULT_COOKIE_INVENTORY: CookieItem[] = [
  {
    id: "session",
    name: "__Host-rp_session",
    provider: "This portal",
    category: "necessary",
    storage: "cookie",
    firstParty: true,
    purpose: "Keeps you signed in securely. HttpOnly; cannot be read by scripts.",
    duration: "Until sign-out or the session ends",
  },
  {
    id: "csrf",
    name: "__Host-rp_csrf",
    provider: "This portal",
    category: "necessary",
    storage: "cookie",
    firstParty: true,
    purpose: "Protects your requests against cross-site request forgery.",
    duration: "Same as the session",
  },
  {
    id: "consent-choice",
    name: "rp.consent.v1",
    provider: "This portal",
    category: "necessary",
    storage: "local_storage",
    firstParty: true,
    purpose: "Remembers your cookie choice and a random id that links your choices in our consent record.",
    duration: "Up to 13 months",
  },
  {
    id: "posthog",
    name: "PostHog page views",
    provider: "PostHog (host configured by the administrator)",
    category: "analytics",
    storage: "none",
    firstParty: false,
    purpose: "Counts anonymous page views on public pages. Sets no cookie; a new random id is used per page view.",
    duration: "No storage on your device",
  },
  {
    id: "clarity-clck",
    name: "_clck",
    provider: "Microsoft Clarity",
    category: "session_replay",
    storage: "cookie",
    firstParty: true,
    purpose: "Keeps the Clarity user id and preferences so visits can be grouped.",
    duration: "1 year",
  },
  {
    id: "clarity-clsk",
    name: "_clsk",
    provider: "Microsoft Clarity",
    category: "session_replay",
    storage: "cookie",
    firstParty: true,
    purpose: "Connects several page views into one recorded session.",
    duration: "1 day",
  },
  {
    id: "clarity-clid",
    name: "CLID, MUID",
    provider: "Microsoft Clarity (clarity.ms, third party)",
    category: "session_replay",
    storage: "cookie",
    firstParty: false,
    purpose: "Identify the first Clarity visit on this browser. Set on Microsoft's domain; remove them in your browser settings.",
    duration: "1 year",
  },
];

export const COOKIE_INVENTORY = defineSetting({
  key: "privacy.cookie_inventory",
  owner: "platform",
  group: "privacy",
  label: "Cookie inventory",
  description: "Every cookie and storage entry shown to visitors in the preference centre.",
  schema: cookieInventorySchema,
  default: DEFAULT_COOKIE_INVENTORY,
  sensitivity: "public",
  writeCapability: "privacy.consent.manage",
  managedBy: MANAGED,
});

export const CATEGORY_TEXT: Record<ConsentCategoryKey, { label: string; description: string; required: boolean }> = {
  necessary: { label: "Strictly necessary", description: "Sign-in, security and remembering your cookie choice. Always on.", required: true },
  preferences: { label: "Preferences", description: "Remembers choices such as display settings on this device.", required: false },
  analytics: { label: "Analytics (PostHog)", description: "Anonymous page-view counts that help us improve public pages.", required: false },
  session_replay: { label: "Session replay (Microsoft Clarity)", description: "Records clicks and scrolling on public pages, with text masked, to find usability problems.", required: false },
};

/** Length-independent comparison of two ASCII strings. */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/* ------------------------------------------------------------------ inputs */

export const choicesSchema = z.strictObject({ preferences: z.boolean(), analytics: z.boolean(), session_replay: z.boolean() });
export type Choices = z.infer<typeof choicesSchema>;

/** `<consentId>.<signature>` issued by the server; anything else is ignored and a new id is issued. */
export const RECEIPT_PATTERN = /^[A-Za-z0-9_-]{22}\.[0-9a-f]{32}$/;

export const recordInputSchema = z.strictObject({
  /** Opaque receipt from an earlier decision of this browser. Optional, untrusted, only a grouping hint. */
  receipt: z.string().max(64).optional(),
  policyVersion: z.number().int().min(1).max(100_000),
  choices: choicesSchema,
  action: z.enum(CONSENT_ACTIONS),
  source: z.enum(CONSENT_SOURCES),
  gpc: z.boolean(),
});
export type RecordInput = z.infer<typeof recordInputSchema>;

const isoDate = z.coerce.date();
export const searchInputSchema = z.strictObject({
  from: isoDate.optional(),
  to: isoDate.optional(),
  action: z.enum(CONSENT_ACTIONS).optional(),
  source: z.enum(CONSENT_SOURCES).optional(),
  policyVersion: z.number().int().min(1).max(100_000).optional(),
  consentId: z.string().regex(CONSENT_ID_PATTERN).optional(),
  userPublicId: z.string().regex(/^[0-9A-Za-z_-]{1,32}$/).optional(),
  gpc: z.boolean().optional(),
  cursor: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type SearchInput = z.input<typeof searchInputSchema>;

/* ------------------------------------------------------------------ views */

export interface ConsentRecordView {
  publicId: string;
  consentId: string;
  userPublicId: string | null;
  policyVersion: number;
  choices: Choices;
  action: ConsentAction;
  source: ConsentSource;
  gpc: boolean;
  createdAt: Date;
}

export interface Bootstrap {
  features: Record<string, boolean>;
  consent: { enabled: boolean; policyVersion: number; renewMonths: number };
}

export interface ConsentInventory {
  enabled: boolean;
  policyVersion: number;
  renewMonths: number;
  categories: Array<{ key: ConsentCategoryKey; label: string; description: string; required: boolean }>;
  items: CookieItem[];
}

export interface ConsentStats {
  days: number;
  total: number;
  byAction: Record<ConsentAction, number>;
  bySource: Record<ConsentSource, number>;
  /** Share (0–1) of decisions that allowed each optional category. */
  acceptance: Record<"preferences" | "analytics" | "session_replay", number>;
  gpc: number;
  byPolicyVersion: Array<{ policyVersion: number; total: number }>;
}

/* ------------------------------------------------------------------ service */

export interface ConsentServiceDeps {
  db: Db;
  clock: Clock;
  crypto: FieldCrypto;
  audit: AuditEmitter;
  settings: SettingsStore;
  logger: Logger;
}

export const MAX_EXPORT_ROWS = 10_000;
export const MAX_MINE = 200;

/** Action and choices must agree, so the ledger cannot claim "accept all" for a partial choice. */
export function assertConsistent(input: Pick<RecordInput, "action" | "choices" | "source" | "gpc">): void {
  const values = [input.choices.preferences, input.choices.analytics, input.choices.session_replay];
  if (input.action === "accept_all" && !values.every(Boolean)) throw validation("CONSENT_INCONSISTENT", "Accept all must allow every category.");
  if ((input.action === "reject_all" || input.action === "withdraw") && values.some(Boolean)) {
    throw validation("CONSENT_INCONSISTENT", "Reject all must refuse every optional category.");
  }
  if (input.source === "gpc" && (input.action !== "reject_all" || !input.gpc)) throw validation("CONSENT_INCONSISTENT", "A privacy signal can only reject.");
}

function toView(row: typeof platformConsentRecords.$inferSelect): ConsentRecordView {
  return {
    publicId: row.publicId,
    consentId: row.consentId,
    userPublicId: row.userPublicId,
    policyVersion: row.policyVersion,
    choices: { preferences: row.preferences, analytics: row.analytics, session_replay: row.sessionReplay },
    action: row.action,
    source: row.source,
    gpc: row.gpc,
    createdAt: row.createdAt,
  };
}

function randomConsentId(): string {
  // 16 random bytes → 22 base64url characters.
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
}

/** CSV cell: quoted, quotes doubled, and formula-leading characters neutralised (CSV injection). */
export function csvCell(value: string | number | boolean | null): string {
  if (value === null) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function createConsentService(deps: ConsentServiceDeps) {
  const { db, clock, crypto, audit, settings, logger } = deps;
  const log = logger.child({ component: "platform.consent" });

  function signReceipt(consentId: string): string {
    return `${consentId}.${crypto.blindIndex(consentId, "platform.consent.receipt").slice(0, 32)}`;
  }

  function verifyReceipt(receipt: string | undefined): string | null {
    if (receipt === undefined || !RECEIPT_PATTERN.test(receipt)) return null;
    const consentId = receipt.slice(0, 22);
    return constantTimeEqual(signReceipt(consentId), receipt) ? consentId : null;
  }

  async function config() {
    const [enabled, policyVersion, renewMonths] = await Promise.all([
      isFlagEnabled(settings, CONSENT_FLAG),
      readSetting(settings, CONSENT_POLICY_VERSION),
      readSetting(settings, CONSENT_RENEW_MONTHS),
    ]);
    return { enabled, policyVersion, renewMonths };
  }

  function filters(input: z.output<typeof searchInputSchema>): SQL[] {
    const where: SQL[] = [];
    const t = platformConsentRecords;
    if (input.from) where.push(gte(t.createdAt, input.from));
    if (input.to) where.push(lte(t.createdAt, input.to));
    if (input.action) where.push(eq(t.action, input.action));
    if (input.source) where.push(eq(t.source, input.source));
    if (input.policyVersion !== undefined) where.push(eq(t.policyVersion, input.policyVersion));
    if (input.consentId) where.push(eq(t.consentId, input.consentId));
    if (input.userPublicId) where.push(eq(t.userPublicId, input.userPublicId));
    if (input.gpc !== undefined) where.push(eq(t.gpc, input.gpc));
    return where;
  }

  return {
    config,

    async bootstrap(): Promise<Bootstrap> {
      const flags = listSettingDefinitions().filter((d) => d.kind === "flag" && d.clientVisible);
      const features: Record<string, boolean> = {};
      for (const def of flags) {
        if (def.kind !== "flag") continue;
        try {
          features[def.flag] = await settings.isFeatureEnabled(def.flag);
        } catch {
          features[def.flag] = false; // fail closed
        }
      }
      return { features, consent: await config() };
    },

    async inventory(): Promise<ConsentInventory> {
      const [cfg, items] = await Promise.all([config(), readSetting(settings, COOKIE_INVENTORY)]);
      return {
        ...cfg,
        categories: CONSENT_CATEGORIES.map((key) => ({ key, ...CATEGORY_TEXT[key] })),
        items,
      };
    },

    async record(input: RecordInput, context: { userPublicId: string | null; ipAddress: string | null }): Promise<{ consentId: string; receipt: string; recordedAt: Date; policyVersion: number }> {
      const cfg = await config();
      if (!cfg.enabled) throw new DomainError("NOT_FOUND", "CONSENT_DISABLED", "Cookie consent is not enabled.");
      if (input.policyVersion !== cfg.policyVersion) throw conflict("CONSENT_POLICY_CHANGED", "The cookie policy has changed. Please review it and choose again.");
      assertConsistent(input);
      // The consent id only groups one browser's decisions. It is accepted back only inside a receipt the
      // server signed, so a client cannot attach its decisions to another browser's history. It is never
      // used as authority: account history is selected by the session's user, not by consent id.
      const reused = verifyReceipt(input.receipt);
      const consentId = reused ?? randomConsentId();
      const recordedAt = clock.now();
      await db.insert(platformConsentRecords).values({
        consentId,
        userPublicId: context.userPublicId,
        policyVersion: cfg.policyVersion,
        preferences: input.choices.preferences,
        analytics: input.choices.analytics,
        sessionReplay: input.choices.session_replay,
        action: input.action,
        source: input.source,
        gpc: input.gpc,
        ipIndex: context.ipAddress ? crypto.blindIndex(context.ipAddress, "platform.consent.ip") : null,
        createdAt: recordedAt,
      });
      log.info("consent decision recorded", { action: input.action, source: input.source, policy_version: cfg.policyVersion, signed_in: context.userPublicId !== null });
      if (input.receipt !== undefined && reused === null) log.warn("consent receipt rejected", { reason: "invalid_signature_or_format" });
      return { consentId, receipt: signReceipt(consentId), recordedAt, policyVersion: cfg.policyVersion };
    },

    async mine(userPublicId: string): Promise<ConsentRecordView[]> {
      const t = platformConsentRecords;
      const rows = await db.select().from(t).where(eq(t.userPublicId, userPublicId)).orderBy(desc(t.id)).limit(MAX_MINE);
      return rows.map(toView);
    },

    async search(raw: SearchInput): Promise<{ items: ConsentRecordView[]; nextCursor: number | null }> {
      const input = searchInputSchema.parse(raw);
      const t = platformConsentRecords;
      const where = filters(input);
      if (input.cursor) where.push(lt(t.id, input.cursor));
      const rows = await db
        .select()
        .from(t)
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(t.id))
        .limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      return { items: page.map(toView), nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null };
    },

    async stats(days: number): Promise<ConsentStats> {
      const t = platformConsentRecords;
      const since = new Date(clock.now().getTime() - days * 86_400_000);
      const [totals] = await db
        .select({
          total: sql<number>`count(*)`,
          preferences: sql<number>`coalesce(sum(${t.preferences}), 0)`,
          analytics: sql<number>`coalesce(sum(${t.analytics}), 0)`,
          sessionReplay: sql<number>`coalesce(sum(${t.sessionReplay}), 0)`,
          gpc: sql<number>`coalesce(sum(${t.gpc}), 0)`,
        })
        .from(t)
        .where(gte(t.createdAt, since));
      const actions = await db.select({ key: t.action, n: sql<number>`count(*)` }).from(t).where(gte(t.createdAt, since)).groupBy(t.action);
      const sources = await db.select({ key: t.source, n: sql<number>`count(*)` }).from(t).where(gte(t.createdAt, since)).groupBy(t.source);
      const versions = await db
        .select({ policyVersion: t.policyVersion, total: sql<number>`count(*)` })
        .from(t)
        .where(gte(t.createdAt, since))
        .groupBy(t.policyVersion)
        .orderBy(desc(t.policyVersion))
        .limit(20);
      const total = Number(totals?.total ?? 0);
      const share = (n: unknown) => (total === 0 ? 0 : Number(n ?? 0) / total);
      const byAction = Object.fromEntries(CONSENT_ACTIONS.map((a) => [a, 0])) as Record<ConsentAction, number>;
      for (const row of actions) byAction[row.key] = Number(row.n);
      const bySource = Object.fromEntries(CONSENT_SOURCES.map((s) => [s, 0])) as Record<ConsentSource, number>;
      for (const row of sources) bySource[row.key] = Number(row.n);
      return {
        days,
        total,
        byAction,
        bySource,
        acceptance: { preferences: share(totals?.preferences), analytics: share(totals?.analytics), session_replay: share(totals?.sessionReplay) },
        gpc: Number(totals?.gpc ?? 0),
        byPolicyVersion: versions.map((v) => ({ policyVersion: v.policyVersion, total: Number(v.total) })),
      };
    },

    async exportCsv(raw: Omit<SearchInput, "cursor" | "limit">): Promise<{ csv: string; rows: number; truncated: boolean }> {
      const input = searchInputSchema.parse({ ...raw, limit: 100 });
      const t = platformConsentRecords;
      const where = filters(input);
      const rows = await db
        .select()
        .from(t)
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(t.id))
        .limit(MAX_EXPORT_ROWS + 1);
      const truncated = rows.length > MAX_EXPORT_ROWS;
      const kept = rows.slice(0, MAX_EXPORT_ROWS).map(toView);
      const header = ["record_id", "recorded_at", "consent_id", "user_public_id", "policy_version", "preferences", "analytics", "session_replay", "action", "source", "gpc"];
      const lines = [header.join(",")];
      for (const r of kept) {
        lines.push(
          [r.publicId, r.createdAt.toISOString(), r.consentId, r.userPublicId, r.policyVersion, r.choices.preferences, r.choices.analytics, r.choices.session_replay, r.action, r.source, r.gpc]
            .map(csvCell)
            .join(","),
        );
      }
      await audit.record({
        category: "admin",
        eventName: "privacy.consent.exported",
        action: "export",
        outcome: "completed",
        resource: { type: "consent_ledger" },
        safeCounts: { rows: kept.length },
        attributes: { truncated, filtered: where.length > 0 },
      });
      return { csv: `${lines.join("\r\n")}\r\n`, rows: kept.length, truncated };
    },
  };
}

export type ConsentService = ReturnType<typeof createConsentService>;
