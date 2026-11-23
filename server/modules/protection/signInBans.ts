import { and, count, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Request } from "express";
import { z } from "zod";
import type { ModuleDeps } from "../../container.js";
import { conflict, forbidden, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { getRequestContext } from "../../core/requestContext.js";
import type { RequestContext, SessionPrincipal, Tx } from "../../core/types.js";
import { clientAddress } from "../../http/edge.js";
import { defineSetting, readSetting, writeSetting } from "../platform/index.js";
import { addressOf, defaultPolicy, parseNetwork, policySchema, type Address, type Network, type ProtectionPolicy } from "./policy.js";
import { protectionPolicies, protectionSignInBans as bans, protectionSignInStrikes as strikes } from "./schema.js";

const MINUTE = 60_000;
const BAN_CAP = 512;
const STRIKE_SLOTS = 16_384;
const ACCOUNT = /^[a-f0-9]{64}$/;
const PUBLIC_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const LOOPBACKS = [parseNetwork("127.0.0.0/8")!, parseNetwork("::1")!];

const escalationDefault = { factor: 4, maxMinutes: 1_440, memoryHours: 24 };
export const signInBanPolicySchema = z.strictObject({
  enabled: z.boolean().default(true),
  threshold: z.number().int().min(3).max(100).default(10),
  windowMinutes: z.number().int().min(1).max(60).default(10),
  banMinutes: z.number().int().min(1).max(120).default(15),
  escalation: z.strictObject({
    factor: z.number().int().min(2).max(8).default(escalationDefault.factor),
    maxMinutes: z.number().int().min(1).max(10_080).default(escalationDefault.maxMinutes),
    memoryHours: z.number().int().min(1).max(168).default(escalationDefault.memoryHours),
  }).default(escalationDefault),
  permanentAfter: z.number().int().min(2).max(20).nullable().default(null),
  countDistinctAccounts: z.boolean().default(true),
}).refine((value) => value.escalation.maxMinutes >= value.banMinutes, {
  path: ["escalation", "maxMinutes"], message: "Set the escalation maximum at or above the initial ban duration.",
});
export type SignInBanPolicy = z.output<typeof signInBanPolicySchema>;
export const signInBanSetting = defineSetting({
  key: "protection.signin_bans",
  owner: "protection",
  group: "security",
  label: "Sign-in bans",
  description: "Temporary or escalated address bans for repeated failed sign-in attempts.",
  schema: signInBanPolicySchema,
  default: signInBanPolicySchema.parse({}),
  sensitivity: "internal",
  exportable: false,
  writeCapability: "security.firewall.manage",
  managedBy: { href: "/admin/protection/bans", label: "Sign-in bans" },
});

export interface SignInSignal {
  ip: string | null | undefined;
  accountRef?: string | undefined;
  kind: "password" | "mfa" | "recovery_code" | "passkey" | "password_reset" | "sso_callback";
  outcome: "success" | "failure";
  correlationId: string;
  at: Date;
}

const credentialProcedures = new Set([
  "identity.signin", "identity.resetpassword", "identity.requestpasswordreset", "identity.activateaccount",
  "identity.changepassword", "identity.register", "assurance.recoverunacknowledgedcodes",
  "assurance.challenge", "assurance.beginpasskeyauthentication", "assurance.finishpasskeyauthentication",
  "assurance.confirmpasskeyauthentication",
]);

export function isSignInRequest(req: Pick<Request, "path" | "method">): boolean {
  const path = req.path.toLowerCase();
  if ((req.method === "GET" || req.method === "HEAD") && /^\/api\/identity\/sso\/(?:start|callback)\/?$/.test(path)) return true;
  if (req.method === "POST" && /^\/api\/identity\/sso\/complete\/?$/.test(path)) return true;
  if (req.method !== "POST" || !path.startsWith("/api/trpc/")) return false;
  try {
    const list = decodeURIComponent(path.slice("/api/trpc/".length)).toLowerCase();
    return /^[a-z0-9_.]+(?:,[a-z0-9_.]+)*$/.test(list) && list.split(",").some((item) => credentialProcedures.has(item));
  } catch {
    return false;
  }
}

function exact(address: Address): Network {
  return { address, length: address.family === 4 ? 32 : 128 };
}

function within(network: Network, address: Address): boolean {
  if (network.address.family !== address.family) return false;
  const shift = BigInt((address.family === 4 ? 32 : 128) - network.length);
  return network.address.number >> shift === address.number >> shift;
}

function overlaps(a: Network, b: Network) {
  return within(a, b.address) || within(b, a.address);
}

function trustedNetwork(value: string): Network | undefined {
  const [raw, prefix] = value.split("/");
  const address = addressOf(raw);
  if (!address) return undefined;
  const bits = address.family === 4 ? 32 : 128;
  const mapped = address.family === 4 && raw?.includes(":");
  const length = prefix === undefined ? bits : mapped ? Math.max(0, Number(prefix) - 96) : Number(prefix);
  return Number.isInteger(length) && length >= 0 && length <= bits ? { address, length } : undefined;
}

const canonical = (range: Network) => `${range.address.text}/${range.length}`;
const display = (range: Network) => range.length === exact(range.address).length ? range.address.text : canonical(range);

export function createSignInBans(
  deps: ModuleDeps,
  assertActor: (principal: SessionPrincipal | null, manage: boolean, tx: Tx) => Promise<void>,
) {
  const { db, clock, config, crypto, settings, audit } = deps;
  const trusted = config.trustedProxies.flatMap((value) => {
    const range = trustedNetwork(value);
    return range ? [range] : [];
  });
  const contextAddresses = new WeakMap<RequestContext, Address>();
  // The installation pseudonym root is independent of data-key and blind-index rotations.
  const keyOf = (range: Network) => crypto.pseudonym(canonical(range), "protection.signin_ban.address");
  const slotOf = (addressKey: string) => Number.parseInt(addressKey.slice(0, 8), 16) % STRIKE_SLOTS;
  const aad = (publicId: string) => `protection_signin_bans.address_enc:${publicId}`;
  const liveAt = (now: Date) => or(isNull(bans.expiresAt), gt(bans.expiresAt, now));
  let lastWarning = Number.NEGATIVE_INFINITY;

  function warning() {
    const now = clock.now().getTime();
    if (lastWarning + MINUTE > now) return;
    lastWarning = now;
    deps.logger.warn("sign-in ban state could not be read or written", { reasonCode: "SIGNIN_BAN_STORAGE_UNAVAILABLE" });
  }

  function allowedRanges(policy: ProtectionPolicy, now: number) {
    return [...LOOPBACKS, ...trusted, ...policy.ipLists.flatMap((entry) => {
      const range = entry.action === "allow" && (entry.expiresAt === null || Date.parse(entry.expiresAt) > now)
        ? parseNetwork(entry.network) : undefined;
      return range ? [range] : [];
    })];
  }

  function capture(req: Request) {
    const context = getRequestContext();
    if (!context || config.protectionDisabled) return;
    const peer = addressOf(req.socket.remoteAddress);
    const resolved = addressOf(clientAddress(req));
    if (!peer || !resolved || resolved.number === 0n) return;
    const throughTrustedProxy = trusted.some((range) => within(range, peer));
    if (throughTrustedProxy && (resolved.text === peer.text || !req.get("X-Forwarded-For"))) return;
    // A local/untrusted intermediary cannot promote its forwarding headers to a client identity.
    if (!throughTrustedProxy && (trusted.length > 0 || LOOPBACKS.some((range) => within(range, peer)))) return;
    if ([...LOOPBACKS, ...trusted].some((range) => within(range, resolved))) return;
    contextAddresses.set(context, resolved);
  }

  function currentAddress() {
    const ctx = getRequestContext();
    return ctx ? contextAddresses.get(ctx) : undefined;
  }

  async function lockPolicy(tx: Tx) {
    // A singleton policy row coordinates cross-replica cap eviction and allow-list changes.
    await tx.insert(protectionPolicies).values({ id: 1, policy: defaultPolicy, version: 1, updatedAt: clock.now() })
      .onDuplicateKeyUpdate({ set: { id: 1 } });
    const [row] = await tx.select({ policy: protectionPolicies.policy }).from(protectionPolicies)
      .where(eq(protectionPolicies.id, 1)).for("update");
    return row ? policySchema.parse(row.policy) : defaultPolicy;
  }

  async function emit(event: "created" | "released", row: { publicId: string; source: "automatic" | "manual" }, address: string | undefined, tx: Tx, correlationId?: string) {
    await audit.record({
      category: "security", eventName: `security.ban.${event}`, action: event === "created" ? "ban" : "release",
      outcome: "completed", severity: "WARN", resource: { type: "signin_ban", publicId: row.publicId },
      ...(!getRequestContext() ? { actor: { role: "system" as const } } : {}),
      ...(correlationId && PUBLIC_ID.test(correlationId) ? { correlationId } : {}),
      attributes: {
        ban_public_id: row.publicId,
        automatic: row.source === "automatic",
        ...(address ? { address_ref: crypto.pseudonym(address, "audit.source_address").slice(0, 32) } : {}),
      },
    }, tx);
  }

  async function addBan(
    tx: Tx, network: Network, source: "automatic" | "manual", reason: string,
    failures: number, expiresAt: Date | null, now: Date, correlationId?: string,
  ) {
    const addressKey = keyOf(network);
    const [existing] = await tx.select().from(bans).where(and(eq(bans.addressKey, addressKey), liveAt(now))).limit(1);
    if (existing) {
      if (source === "manual") throw conflict("SIGNIN_BAN_ALREADY_ACTIVE", "An active ban already covers this exact entry.");
      return { publicId: existing.publicId, expiresAt: existing.expiresAt };
    }
    await tx.delete(bans).where(lte(bans.expiresAt, now));
    const [size] = await tx.select({ total: count() }).from(bans);
    if ((size?.total ?? 0) >= BAN_CAP) {
      // Never evict a permanent ban; remove the oldest temporary entry first.
      const [oldest] = await tx.select().from(bans).where(sql`${bans.expiresAt} is not null`)
        .orderBy(bans.createdAt, bans.id).limit(1);
      if (!oldest) return null;
      await tx.delete(bans).where(eq(bans.id, oldest.id));
      await emit("released", oldest, crypto.decrypt(oldest.addressEnc, aad(oldest.publicId)), tx);
    }
    const publicId = ulid(now.getTime());
    await tx.insert(bans).values({
      publicId, addressKey, addressEnc: crypto.encrypt(display(network), aad(publicId)),
      source, reason, strikes: failures, expiresAt, createdAt: now,
    });
    await emit("created", { publicId, source }, display(network), tx, correlationId);
    return { publicId, expiresAt };
  }

  function addressKeys(address: Address) {
    const bits = exact(address).length;
    const keys: string[] = [];
    for (let length = address.family === 4 ? 8 : 16; length <= bits; length++) {
      const shift = BigInt(bits - length);
      const prefix = address.number >> shift << shift;
      const value = address.family === 4
        ? [24n, 16n, 8n, 0n].map((offset) => String(Number(prefix >> offset & 255n))).join(".")
        : Array.from({ length: 8 }, (_, index) => (prefix >> BigInt((7 - index) * 16) & 65535n).toString(16)).join(":");
      const networkAddress = addressOf(value);
      if (networkAddress?.family === address.family) keys.push(keyOf({ address: networkAddress, length }));
    }
    return keys;
  }

  async function list(tx: Tx) {
    const rows = await tx.select().from(bans).where(liveAt(clock.now())).orderBy(sql`${bans.createdAt} desc`, bans.id).limit(BAN_CAP);
    return rows.map((row) => ({
      publicId: row.publicId, address: crypto.decrypt(row.addressEnc, aad(row.publicId)),
      source: row.source, reason: row.reason, strikes: row.strikes, expiresAt: row.expiresAt, createdAt: row.createdAt,
    }));
  }

  async function release(tx: Tx, publicId?: string) {
    await lockPolicy(tx);
    const rows = await tx.select().from(bans).where(publicId ? eq(bans.publicId, publicId) : undefined).limit(BAN_CAP);
    for (const row of rows) {
      let address: string | undefined;
      try { address = crypto.decrypt(row.addressEnc, aad(row.publicId)); } catch { warning(); }
      await tx.delete(bans).where(eq(bans.id, row.id));
      await tx.delete(strikes).where(and(eq(strikes.slot, slotOf(row.addressKey)), eq(strikes.addressKey, row.addressKey)));
      await emit("released", row, address, tx);
    }
    return rows.length;
  }

  const cleanupJob = "protection.signin_bans.cleanup";
  deps.jobs.register(cleanupJob, async (job) => {
    await job.assertStillOwned();
    const now = clock.now();
    const [expired] = await db.delete(bans).where(lte(bans.expiresAt, now)).limit(BAN_CAP);
    // Seven days is the maximum allowed escalation memory. No raw addresses or accounts in strikes.
    const [aged] = await db.delete(strikes).where(lte(strikes.updatedAt, new Date(now.getTime() - 168 * 60 * MINUTE))).limit(4_000);
    return { outcome: "completed", safeCounts: { bans: expired.affectedRows, strikes: aged.affectedRows } };
  });
  deps.jobs.registerSchedule({ name: cleanupJob, type: cleanupJob, everyMs: 15 * MINUTE });

  return {
    capture,
    clientAddressTrust() { return { determinable: Boolean(currentAddress()) }; },
    async checkSignInBan(loadPolicy: (tx: Tx) => Promise<ProtectionPolicy>): Promise<number> {
      const address = currentAddress();
      const now = clock.now();
      if (!address) return 0;
      try {
        const rows = await db.select({ source: bans.source, expiresAt: bans.expiresAt }).from(bans)
          .where(and(inArray(bans.addressKey, addressKeys(address)), liveAt(now)));
        if (!rows.length) return 0;
        return await db.transaction(async (tx) => {
          if (allowedRanges(await loadPolicy(tx), now.getTime()).some((range) => within(range, address))) return 0;
          const options = rows.some((row) => row.source === "automatic") ? await readSetting(settings, signInBanSetting, tx) : undefined;
          return rows.reduce((wait, row) => row.source === "automatic" && !options?.enabled ? wait : Math.max(wait,
            row.expiresAt === null ? 3_600 : Math.max(1, Math.ceil((row.expiresAt.getTime() - now.getTime()) / 1000))), 0);
        }, { isolationLevel: "read committed", accessMode: "read only" });
      } catch {
        warning();
        return 0;
      }
    },
    async recordSignInSignal(signal: SignInSignal): Promise<void> {
      const address = currentAddress();
      if (!address || addressOf(signal.ip ?? undefined)?.text !== address.text || signal.outcome !== "failure") return;
      try {
        const now = clock.now();
        const nowMs = now.getTime();
        if (!Number.isFinite(signal.at.getTime()) || Math.abs(nowMs - signal.at.getTime()) > 60 * MINUTE) return;
        const range = exact(address);
        const addressKey = keyOf(range);
        const slot = slotOf(addressKey);
        await db.transaction(async (tx) => {
          const policy = await lockPolicy(tx);
          if (allowedRanges(policy, nowMs).some((protectedRange) => within(protectedRange, address))) return;
          const options = await readSetting(settings, signInBanSetting, tx);
          if (!options.enabled || Math.abs(nowMs - signal.at.getTime()) > options.windowMinutes * MINUTE) return;
          await tx.insert(strikes).values({ slot, addressKey, failures: [], updatedAt: now }).onDuplicateKeyUpdate({ set: { slot } });
          const [row] = await tx.select().from(strikes).where(eq(strikes.slot, slot)).for("update");
          if (!row) return;
          const cutoff = nowMs - options.windowMinutes * MINUTE;
          const memory = nowMs - options.escalation.memoryHours * 60 * MINUTE;
          const sameAddress = row.addressKey === addressKey;
          if (!sameAddress && (row.updatedAt.getTime() > cutoff || (row.lastBanAt?.getTime() ?? 0) > memory)) return;
          const accountRef = signal.accountRef && ACCOUNT.test(signal.accountRef) ? signal.accountRef : null;
          const valid = sameAddress ? row.failures.filter((failure) => failure.atMs > cutoff) : [];
          const failures = [...valid, { atMs: nowMs, accountRef }].slice(-200);
          const distinct = new Set(failures.flatMap((failure) => failure.accountRef ? [failure.accountRef] : []));
          const thresholdMet = failures.length >= options.threshold &&
            (!options.countDistinctAccounts || distinct.size >= 2 || distinct.size === 0 || failures.length >= options.threshold * 2);
          const remembered = sameAddress && (row.lastBanAt?.getTime() ?? 0) > memory;
          const banCount = remembered ? row.banCount : 0;
          if (!thresholdMet) {
            await tx.update(strikes).set({ addressKey, failures, banCount, lastBanAt: remembered ? row.lastBanAt : null, updatedAt: now }).where(eq(strikes.slot, slot));
            return;
          }
          const [active] = await tx.select({ id: bans.id }).from(bans).where(and(eq(bans.addressKey, addressKey), liveAt(now))).limit(1);
          if (active) return;
          const next = Math.min(100, banCount + 1);
          const expiresAt = options.permanentAfter !== null && next >= options.permanentAfter ? null :
            new Date(nowMs + Math.min(options.escalation.maxMinutes, options.banMinutes * options.escalation.factor ** (next - 1)) * MINUTE);
          if (!(await addBan(tx, range, "automatic", "Repeated failed sign-in attempts", failures.length, expiresAt, now, signal.correlationId))) return;
          await tx.update(strikes).set({ addressKey, failures: [], banCount: next, lastBanAt: now, updatedAt: now }).where(eq(strikes.slot, slot));
        });
      } catch {
        warning();
      }
    },
    listSignInBans(principal: SessionPrincipal | null) {
      return db.transaction(async (tx) => {
        await assertActor(principal, false, tx);
        return { items: await list(tx), policy: await readSetting(settings, signInBanSetting, tx), determinable: Boolean(currentAddress()), bypassed: config.protectionDisabled === true };
      });
    },
    setSignInBanPolicy(principal: SessionPrincipal | null, input: SignInBanPolicy) {
      const policy = signInBanPolicySchema.parse(input);
      return db.transaction(async (tx) => {
        await assertActor(principal, true, tx);
        await lockPolicy(tx);
        await writeSetting(settings, signInBanSetting, policy, tx);
        await audit.record({
          category: "security", eventName: "security.ban.policy_updated", action: "update",
          outcome: "completed", severity: "INFO", attributes: { enabled: policy.enabled, threshold: policy.threshold },
        }, tx);
        return policy;
      });
    },
    manualSignInBan(principal: SessionPrincipal | null, input: { address: string; durationMinutes: number | null; reason: string }) {
      const network = parseNetwork(input.address.trim());
      const reason = input.reason.trim();
      if (!network || reason.length < 3 || reason.length > 240 || Array.from(reason).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
          (input.durationMinutes !== null && (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 10_080))) {
        throw validation("INVALID_SIGNIN_BAN", "Enter a canonical IP or CIDR, a valid duration, and a reason.");
      }
      return db.transaction(async (tx) => {
        await assertActor(principal, true, tx);
        const actorAddress = currentAddress();
        if (!actorAddress) throw forbidden("ADMIN_ADDRESS_UNVERIFIABLE");
        const now = clock.now();
        const policy = await lockPolicy(tx);
        if (within(network, actorAddress) || allowedRanges(policy, now.getTime()).some((range) => overlaps(network, range))) {
          throw validation("SIGNIN_BAN_PROTECTED_ADDRESS", "This range includes a protected, allowed, or current administrator address.");
        }
        const expires = input.durationMinutes === null ? null : new Date(now.getTime() + input.durationMinutes * MINUTE);
        const result = await addBan(tx, network, "manual", reason, 0, expires, now);
        if (!result) throw conflict("SIGNIN_BAN_LIST_FULL", "The ban list is full. Release an existing ban before adding another.");
        return result;
      });
    },
    releaseSignInBan(principal: SessionPrincipal | null, input: { publicId: string }) {
      return db.transaction(async (tx) => {
        await assertActor(principal, true, tx);
        if (!(await release(tx, input.publicId))) throw notFound("SIGNIN_BAN_NOT_FOUND");
        return { released: true as const };
      });
    },
    operatorListSignInBans: () => db.select({
      publicId: bans.publicId, source: bans.source, strikes: bans.strikes, expiresAt: bans.expiresAt,
    }).from(bans).where(liveAt(clock.now())).orderBy(sql`${bans.createdAt} desc`, bans.id).limit(BAN_CAP),
    operatorClearSignInBans: (publicId?: string) => db.transaction((tx) => release(tx, publicId)),
  };
}
