import { and, count, desc, eq, gte, inArray, lte, lt, sql } from "drizzle-orm";
import type { ResultSetHeader } from "mysql2";
import { roleHasCapability } from "../../../shared/capabilities.js";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { ulid, ULID_PATTERN } from "../../core/ids.js";
import type { DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { users } from "../identity/schema.js";
import { isFlagEnabled, readSetting, writeSetting } from "../platform/index.js";
import { assertLiveActorInTx, denyReferralsAuthz, runReferralsTx } from "./actorAuth.js";
import {
  canonicalEmailIdentity,
  computeReferralReward,
  decodeIdCursor,
  encodeIdCursor,
  generateReferralCode,
  maskReferredCustomerHint,
  normalizeReferralCode,
  normalizeReferralEmail,
  sanitizeSenderDisplayName,
  serializeSafeCsv,
} from "./codes.js";
import { REFERRALS_INVITE_TEMPLATE_KEY } from "./mail.js";
import {
  referralCodes,
  referralEmailInvites,
  referralRewardLedger,
  referrals,
  type ReferralLedgerEntryType,
  type ReferralPayoutMethod,
  type ReferralRewardMode,
  type ReferralRow,
  type ReferralStatus,
} from "./schema.js";
import {
  REFERRALS_ENABLED_FLAG,
  REFERRALS_PROGRAM_CONFIG,
  type ReferralProgramConfig,
} from "./settings.js";

export type ReferralAttributionRefusalCode =
  | "PROGRAM_DISABLED"
  | "CODE_INVALID"
  | "CODE_NOT_FOUND"
  | "CODE_DISABLED"
  | "REFERRER_INELIGIBLE"
  | "NEW_USER_INELIGIBLE"
  | "SELF_REFERRAL"
  | "SAME_ACCOUNT"
  | "ALREADY_ATTRIBUTED";

export interface AttributeRegistrationResult {
  attributed: boolean;
  referralPublicId?: string;
  reasonCode?: ReferralAttributionRefusalCode;
}

export interface ValidateReferralCodeResult {
  valid: boolean;
  programEnabled: boolean;
  normalizedCode: string | null;
  reasonCode?: ReferralAttributionRefusalCode;
}

export interface InvoicePaidReferralEvent {
  invoicePublicId: string;
  orderPublicId: string;
  customerUserId: number;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  isFirstPaidInvoice?: boolean;
  paidAt?: Date;
}

export type OnInvoicePaidReferralOutcome =
  | "qualified_pending_approval"
  | "auto_approved"
  | "not_referred"
  | "program_disabled"
  | "already_processed"
  | "already_qualified"
  | "not_first_invoice"
  | "referrer_ineligible";

export interface OnInvoicePaidReferralResult {
  outcome: OnInvoicePaidReferralOutcome;
  referralPublicId?: string;
  rewardAmountMinor?: number;
  currency?: string;
}

export interface CustomerReferralOverviewView {
  code: string;
  shareUrl: string;
  sharePath: string;
  program: {
    rewardMode: ReferralRewardMode;
    fixedAmountMinor: number;
    percentBps: number;
    capAmountMinor: number;
    currency: string;
    manualApprovalRequired: boolean;
  };
  stats: {
    total: number;
    pending: number;
    approved: number;
    credited: number;
    rejected: number;
    approvedRewardMinor: number;
    creditedRewardMinor: number;
    currency: string;
  };
}

export interface CustomerReferralHistoryItemView {
  referralPublicId: string;
  referredAccountHint: string;
  status: ReferralStatus;
  rewardAmountMinor: number;
  currency: string;
  attributedAt: Date;
  qualifiedAt: Date | null;
  reviewedAt: Date | null;
  creditedAt: Date | null;
}

export interface AdminReferralItemView {
  referralPublicId: string;
  codeSnapshot: string;
  status: ReferralStatus;
  referrerPublicId: string;
  referrerCustomerRef: string | null;
  referrerName: string;
  referredPublicId: string;
  referredCustomerRef: string | null;
  referredName: string;
  rewardMode: ReferralRewardMode | null;
  rewardPercentBps: number | null;
  rewardCapMinor: number | null;
  rewardAmountMinor: number;
  currency: string;
  qualifyingInvoicePublicId: string | null;
  qualifyingOrderPublicId: string | null;
  invoiceTotalMinor: number | null;
  invoiceCurrency: string | null;
  qualificationNoteCode: string | null;
  attributedAt: Date;
  qualifiedAt: Date | null;
  reviewedAt: Date | null;
  reviewReason: string | null;
  creditedAt: Date | null;
  payoutMethod: ReferralPayoutMethod | null;
  payoutReference: string | null;
  payoutNote: string | null;
  version: number;
}

export interface AdminRewardLedgerItemView {
  ledgerPublicId: string;
  referralPublicId: string;
  referrerPublicId: string;
  referrerCustomerRef: string | null;
  referrerName: string;
  entryType: ReferralLedgerEntryType;
  amountMinor: number;
  currency: string;
  payoutMethod: ReferralPayoutMethod | null;
  reference: string | null;
  note: string | null;
  createdAt: Date;
}

export interface AdminReferralsSettingsView {
  enabled: boolean;
  config: ReferralProgramConfig;
  summary: {
    totalReferrals: number;
    pendingApproval: number;
    approvedAwaitingCredit: number;
    creditedCount: number;
    approvedAmountMinor: number;
    creditedAmountMinor: number;
    currency: string;
  };
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

interface LoadedUserSummary {
  userId: number;
  publicId: string;
  customerRef: string | null;
  role: "customer" | "staff" | "admin";
  status: "pending_activation" | "active" | "suspended" | "deactivated";
  email: string;
  name: string;
}

function affectedRows(res: unknown): number {
  if (Array.isArray(res) && res[0] && typeof (res[0] as ResultSetHeader).affectedRows === "number") {
    return (res[0] as ResultSetHeader).affectedRows;
  }
  if (res && typeof (res as ResultSetHeader).affectedRows === "number") {
    return (res as ResultSetHeader).affectedRows;
  }
  return 0;
}

function isDuplicateEntryError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown; cause?: { code?: unknown } }).code ??
    (err as { cause?: { code?: unknown } }).cause?.code;
  return code === "ER_DUP_ENTRY";
}

export function createReferralsService(deps: ModuleDeps) {
  const throttleSampleMap = new Map<string, number>();

  function sampleNote(slot: string, emit: () => void): void {
    const nowMs = deps.clock.now().getTime();
    const prev = throttleSampleMap.get(slot);
    if (prev === undefined || nowMs - prev >= 60_000 || nowMs < prev) {
      if (throttleSampleMap.size >= 2048) throttleSampleMap.clear();
      throttleSampleMap.set(slot, nowMs);
      emit();
    }
  }

  async function loadUserSummary(dbOrTx: DbOrTx, userId: number): Promise<LoadedUserSummary | null> {
    const identitySvc = (deps.services as Partial<typeof deps.services>).identity;
    if (identitySvc?.getUser) {
      const view = await identitySvc.getUser(userId, { tx: dbOrTx });
      if (!view) return null;
      return {
        userId: view.id,
        publicId: view.publicId,
        customerRef: view.customerRef,
        role: view.role,
        status: view.status,
        email: view.email,
        name: view.name,
      };
    }
    const [row] = await dbOrTx
      .select({
        id: users.id,
        publicId: users.publicId,
        customerRef: users.customerRef,
        role: users.role,
        status: users.status,
        emailEnc: users.emailEnc,
        nameEnc: users.nameEnc,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return null;
    return {
      userId: row.id,
      publicId: row.publicId,
      customerRef: row.customerRef,
      role: row.role,
      status: row.status,
      email: deps.crypto.decrypt(row.emailEnc, `users.email:${row.publicId}`),
      name: deps.crypto.decrypt(row.nameEnc, `users.name:${row.publicId}`),
    };
  }

  async function loadUsersByIds(
    dbOrTx: DbOrTx,
    userIds: readonly number[],
  ): Promise<Map<number, LoadedUserSummary>> {
    const uniqueIds = [...new Set(userIds)];
    const out = new Map<number, LoadedUserSummary>();
    if (uniqueIds.length === 0) return out;
    const rows = await dbOrTx
      .select({
        id: users.id,
        publicId: users.publicId,
        customerRef: users.customerRef,
        role: users.role,
        status: users.status,
        emailEnc: users.emailEnc,
        nameEnc: users.nameEnc,
      })
      .from(users)
      .where(inArray(users.id, uniqueIds));
    for (const row of rows) {
      out.set(row.id, {
        userId: row.id,
        publicId: row.publicId,
        customerRef: row.customerRef,
        role: row.role,
        status: row.status,
        email: deps.crypto.decrypt(row.emailEnc, `users.email:${row.publicId}`),
        name: deps.crypto.decrypt(row.nameEnc, `users.name:${row.publicId}`),
      });
    }
    return out;
  }

  async function findExistingUserByEmail(dbOrTx: DbOrTx, email: string): Promise<boolean> {
    const normalized = normalizeReferralEmail(email);
    const identitySvc = (deps.services as Partial<typeof deps.services>).identity;
    if (identitySvc?.findUserIdByEmail) {
      const existing = await identitySvc.findUserIdByEmail(normalized, { tx: dbOrTx });
      return existing !== null;
    }
    const emailIndex = deps.crypto.blindIndex(normalized, "users.email");
    const [row] = await dbOrTx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.emailIndex, emailIndex))
      .limit(1);
    return Boolean(row);
  }

  async function assertStaffReadCapability(principal: SessionPrincipal): Promise<void> {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) {
      throw new DomainError(
        "REMEDIATION_REQUIRED",
        "ACCOUNT_STEP_PENDING",
        "Please finish securing your account to continue.",
      );
    }
    if (!roleHasCapability(principal.role, "referrals.read_all")) {
      await denyReferralsAuthz(deps, principal, "CAPABILITY_NOT_GRANTED", { type: "referrals" });
    }
  }

  async function assertCustomerProgramAccess(
    principal: SessionPrincipal,
    tx?: Tx,
  ): Promise<LoadedUserSummary> {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) {
      throw new DomainError(
        "REMEDIATION_REQUIRED",
        "ACCOUNT_STEP_PENDING",
        "Please finish securing your account to continue.",
      );
    }
    const enabled = await isFlagEnabled(deps.settings, REFERRALS_ENABLED_FLAG, tx);
    if (!enabled) {
      throw notFound("REFERRALS_DISABLED");
    }
    if (principal.role !== "customer") {
      await denyReferralsAuthz(deps, principal, "CUSTOMER_ONLY_RESOURCE", {
        type: "referral_account",
        publicId: principal.userPublicId,
      });
    }
    const user = await loadUserSummary(tx ?? deps.db, principal.userId);
    if (!user || user.status !== "active" || user.role !== "customer") {
      throw new DomainError(
        "UNAUTHENTICATED",
        "SESSION_NOT_CURRENT",
        "Your session is no longer active. Please sign in again.",
      );
    }
    return user;
  }

  async function ensureCustomerReferralCode(
    userId: number,
    tx?: Tx,
  ): Promise<{ id: number; publicId: string; code: string; active: boolean }> {
    const runner = async (conn: Tx) => {
      const [existing] = await conn
        .select({
          id: referralCodes.id,
          publicId: referralCodes.publicId,
          code: referralCodes.code,
          active: referralCodes.active,
        })
        .from(referralCodes)
        .where(eq(referralCodes.userId, userId))
        .limit(1);
      if (existing) return existing;

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = generateReferralCode();
        const publicId = ulid();
        try {
          await conn.insert(referralCodes).values({
            publicId,
            userId,
            code: candidate,
            active: true,
          });
          const [created] = await conn
            .select({
              id: referralCodes.id,
              publicId: referralCodes.publicId,
              code: referralCodes.code,
              active: referralCodes.active,
            })
            .from(referralCodes)
            .where(eq(referralCodes.userId, userId))
            .limit(1);
          if (created) return created;
        } catch (err) {
          if (isDuplicateEntryError(err)) {
            const [concurrent] = await conn
              .select({
                id: referralCodes.id,
                publicId: referralCodes.publicId,
                code: referralCodes.code,
                active: referralCodes.active,
              })
              .from(referralCodes)
              .where(eq(referralCodes.userId, userId))
              .limit(1);
            if (concurrent) return concurrent;
            continue;
          }
          throw err;
        }
      }
      throw new DomainError(
        "UNAVAILABLE",
        "CODE_ALLOCATION_FAILED",
        "Unable to allocate a referral code right now. Please try again.",
      );
    };

    if (tx) return runner(tx);
    return deps.db.transaction(runner);
  }

  function buildShareLinks(code: string): { sharePath: string; shareUrl: string } {
    const sharePath = `/register?ref=${encodeURIComponent(code)}`;
    const shareUrl = new URL(sharePath, deps.config.canonicalOrigin).href;
    return { sharePath, shareUrl };
  }

  /* ------------------------------------------------ public & internal ports */

  /**
   * Public status + purely syntactic code check.
   * NEVER queries `referral_codes` so unauthenticated callers have zero DB enumeration oracle.
   */
  async function publicStatus(input?: { code?: string }): Promise<{
    enabled: boolean;
    codeAcceptedFormat: boolean;
    normalizedCode: string | null;
  }> {
    const enabled = await isFlagEnabled(deps.settings, REFERRALS_ENABLED_FLAG);
    if (!input?.code) {
      return { enabled, codeAcceptedFormat: false, normalizedCode: null };
    }
    const normalizedCode = normalizeReferralCode(input.code);
    return {
      enabled,
      codeAcceptedFormat: enabled && normalizedCode !== null,
      normalizedCode: enabled ? normalizedCode : null,
    };
  }

  /**
   * Internal server-side validation port (`deps.services.referrals.validateCode`).
   * Never returns referrer PII. Applies `auth_high_risk` rate limiting when `opts.ipAddress` is passed.
   */
  async function validateCode(
    code: string,
    opts?: { tx?: DbOrTx; ipAddress?: string },
  ): Promise<ValidateReferralCodeResult> {
    if (opts?.ipAddress) {
      const subject = `referrals.validate:${deps.crypto.blindIndex(opts.ipAddress, "referrals.validate_ip")}`;
      const verdict = await deps.rateLimiter.consume("auth_high_risk", subject);
      if (!verdict.allowed) {
        sampleNote(subject, () => {
          deps.audit.note({
            category: "security",
            eventName: "referral.code.enumeration_throttled",
            action: "verify",
            outcome: "denied",
            severity: "WARN",
            reasonCode: "RATE_LIMITED",
            actor: { role: "anonymous" },
          });
        });
        throw new DomainError(
          "RATE_LIMITED",
          "RATE_LIMITED",
          "Too many referral code checks. Please wait a moment and try again.",
          { retryAfterSeconds: verdict.retryAfterSeconds },
        );
      }
    }

    const dbOrTx = opts?.tx ?? deps.db;
    const txForSettings = opts?.tx && "rollback" in opts.tx ? (opts.tx as Tx) : undefined;
    const programEnabled = await isFlagEnabled(deps.settings, REFERRALS_ENABLED_FLAG, txForSettings);
    const normalizedCode = normalizeReferralCode(code);
    if (!programEnabled) {
      return {
        valid: false,
        programEnabled: false,
        normalizedCode,
        reasonCode: "PROGRAM_DISABLED",
      };
    }
    if (!normalizedCode) {
      return {
        valid: false,
        programEnabled: true,
        normalizedCode: null,
        reasonCode: "CODE_INVALID",
      };
    }

    const [codeRow] = await dbOrTx
      .select({
        id: referralCodes.id,
        userId: referralCodes.userId,
        active: referralCodes.active,
      })
      .from(referralCodes)
      .where(eq(referralCodes.code, normalizedCode))
      .limit(1);

    if (!codeRow) {
      return {
        valid: false,
        programEnabled: true,
        normalizedCode,
        reasonCode: "CODE_NOT_FOUND",
      };
    }
    if (!codeRow.active) {
      return {
        valid: false,
        programEnabled: true,
        normalizedCode,
        reasonCode: "CODE_DISABLED",
      };
    }

    const referrer = await loadUserSummary(dbOrTx, codeRow.userId);
    if (!referrer || referrer.role !== "customer" || referrer.status !== "active") {
      return {
        valid: false,
        programEnabled: true,
        normalizedCode,
        reasonCode: "REFERRER_INELIGIBLE",
      };
    }

    return {
      valid: true,
      programEnabled: true,
      normalizedCode,
    };
  }

  /**
   * D -> G port: called inside `identity`'s registration transaction right after inserting the new `users` row.
   * Never throws for invalid/disabled/unknown/self/same-account codes — returns `{ attributed: false, reasonCode }`.
   */
  async function attributeRegistration(
    code: string,
    newUserId: number,
    tx: Tx,
  ): Promise<AttributeRegistrationResult> {
    const enabled = await isFlagEnabled(deps.settings, REFERRALS_ENABLED_FLAG, tx);
    if (!enabled) {
      return { attributed: false, reasonCode: "PROGRAM_DISABLED" };
    }

    const normalizedCode = normalizeReferralCode(code);
    if (!normalizedCode) {
      return { attributed: false, reasonCode: "CODE_INVALID" };
    }

    const [existingForReferred] = await tx
      .select({ id: referrals.id, publicId: referrals.publicId })
      .from(referrals)
      .where(eq(referrals.referredUserId, newUserId))
      .for("update")
      .limit(1);
    if (existingForReferred) {
      return { attributed: false, reasonCode: "ALREADY_ATTRIBUTED" };
    }

    const [codeRow] = await tx
      .select({
        id: referralCodes.id,
        publicId: referralCodes.publicId,
        userId: referralCodes.userId,
        code: referralCodes.code,
        active: referralCodes.active,
      })
      .from(referralCodes)
      .where(eq(referralCodes.code, normalizedCode))
      .for("update")
      .limit(1);

    if (!codeRow) {
      return { attributed: false, reasonCode: "CODE_NOT_FOUND" };
    }
    if (!codeRow.active) {
      return { attributed: false, reasonCode: "CODE_DISABLED" };
    }

    const newUser = await loadUserSummary(tx, newUserId);
    if (!newUser || newUser.role !== "customer") {
      return { attributed: false, reasonCode: "NEW_USER_INELIGIBLE" };
    }

    if (codeRow.userId === newUserId) {
      await deps.audit.record(
        {
          category: "security",
          eventName: "referral.attribution.refused",
          action: "refuse",
          outcome: "refused",
          severity: "WARN",
          reasonCode: "SELF_REFERRAL",
          actor: { userId: newUserId, role: "customer" },
          resource: { type: "referral_code", publicId: codeRow.publicId },
        },
        tx,
      );
      return { attributed: false, reasonCode: "SELF_REFERRAL" };
    }

    const referrer = await loadUserSummary(tx, codeRow.userId);
    if (!referrer || referrer.role !== "customer" || referrer.status !== "active") {
      await deps.audit.record(
        {
          category: "security",
          eventName: "referral.attribution.refused",
          action: "refuse",
          outcome: "refused",
          severity: "INFO",
          reasonCode: "REFERRER_INELIGIBLE",
          actor: { userId: newUserId, role: "customer" },
          resource: { type: "referral_code", publicId: codeRow.publicId },
        },
        tx,
      );
      return { attributed: false, reasonCode: "REFERRER_INELIGIBLE" };
    }

    // Refuse `+alias` / canonical e-mail equivalence self-dealing
    if (canonicalEmailIdentity(referrer.email) === canonicalEmailIdentity(newUser.email)) {
      await deps.audit.record(
        {
          category: "security",
          eventName: "referral.attribution.refused",
          action: "refuse",
          outcome: "refused",
          severity: "WARN",
          reasonCode: "SELF_REFERRAL",
          actor: { userId: newUserId, role: "customer" },
          resource: { type: "referral_code", publicId: codeRow.publicId },
          attributes: { check: "canonical_email_match" },
        },
        tx,
      );
      return { attributed: false, reasonCode: "SELF_REFERRAL" };
    }

    // Refuse same customer account reference if shared/pre-bound
    if (
      referrer.customerRef &&
      newUser.customerRef &&
      referrer.customerRef.trim().toUpperCase() === newUser.customerRef.trim().toUpperCase()
    ) {
      await deps.audit.record(
        {
          category: "security",
          eventName: "referral.attribution.refused",
          action: "refuse",
          outcome: "refused",
          severity: "WARN",
          reasonCode: "SAME_ACCOUNT",
          actor: { userId: newUserId, role: "customer" },
          resource: { type: "referral_code", publicId: codeRow.publicId },
        },
        tx,
      );
      return { attributed: false, reasonCode: "SAME_ACCOUNT" };
    }

    const config = await readSetting(deps.settings, REFERRALS_PROGRAM_CONFIG, tx);
    const now = deps.clock.now();
    const referralPublicId = ulid();

    try {
      await tx.insert(referrals).values({
        publicId: referralPublicId,
        referralCodeId: codeRow.id,
        referrerUserId: referrer.userId,
        referredUserId: newUserId,
        codeSnapshot: codeRow.code,
        status: "attributed",
        rewardAmountMinor: 0,
        currency: config.currency,
        attributedAt: now,
      });
    } catch (err) {
      if (isDuplicateEntryError(err)) {
        return { attributed: false, reasonCode: "ALREADY_ATTRIBUTED" };
      }
      throw err;
    }

    await deps.audit.record(
      {
        category: "business",
        eventName: "referral.attributed",
        action: "create",
        outcome: "completed",
        actor: { userId: newUserId, role: "customer" },
        resource: { type: "referral", publicId: referralPublicId },
        attributes: {
          referral_code_public_id: codeRow.publicId,
          referrer_public_id: referrer.publicId,
          referred_public_id: newUser.publicId,
        },
      },
      tx,
    );

    return {
      attributed: true,
      referralPublicId,
    };
  }

  /**
   * K / compliance -> G port: qualifies an attributed referral when the referred customer's
   * FIRST invoice becomes fully paid. Safe inside caller's `tx` or standalone.
   */
  async function onInvoicePaidInTx(
    tx: Tx,
    event: InvoicePaidReferralEvent,
  ): Promise<OnInvoicePaidReferralResult> {
    if (
      !ULID_PATTERN.test(event.invoicePublicId) ||
      !ULID_PATTERN.test(event.orderPublicId) ||
      !Number.isSafeInteger(event.totalMinor) ||
      event.totalMinor < 0
    ) {
      throw validation("INVALID_INVOICE_EVENT", "Invalid invoice paid event payload.");
    }

    const enabled = await isFlagEnabled(deps.settings, REFERRALS_ENABLED_FLAG, tx);
    if (!enabled) {
      return { outcome: "program_disabled" };
    }

    const [row] = await tx
      .select()
      .from(referrals)
      .where(eq(referrals.referredUserId, event.customerUserId))
      .for("update")
      .limit(1);

    if (!row) {
      return { outcome: "not_referred" };
    }

    if (row.qualifyingInvoicePublicId === event.invoicePublicId) {
      return {
        outcome: "already_processed",
        referralPublicId: row.publicId,
        rewardAmountMinor: row.rewardAmountMinor,
        currency: row.currency,
      };
    }

    if (row.status !== "attributed") {
      return {
        outcome: "already_qualified",
        referralPublicId: row.publicId,
      };
    }

    if (event.isFirstPaidInvoice === false) {
      return {
        outcome: "not_first_invoice",
        referralPublicId: row.publicId,
      };
    }

    const referrer = await loadUserSummary(tx, row.referrerUserId);
    if (!referrer || referrer.role !== "customer" || referrer.status !== "active") {
      return {
        outcome: "referrer_ineligible",
        referralPublicId: row.publicId,
      };
    }

    const config = await readSetting(deps.settings, REFERRALS_PROGRAM_CONFIG, tx);
    const computed = computeReferralReward(config, {
      currency: event.currency,
      subtotalMinor: event.subtotalMinor,
      discountMinor: event.discountMinor,
      totalMinor: event.totalMinor,
    });

    const now = event.paidAt ?? deps.clock.now();
    const canAutoApprove =
      !config.manualApprovalRequired &&
      computed.qualificationNoteCode === null &&
      computed.rewardAmountMinor > 0;
    const nextStatus: ReferralStatus = canAutoApprove ? "approved" : "qualified_pending_approval";

    const updateRes = await tx
      .update(referrals)
      .set({
        status: nextStatus,
        rewardMode: computed.rewardMode,
        rewardPercentBps: computed.rewardPercentBps,
        rewardCapMinor: computed.rewardCapMinor,
        rewardAmountMinor: computed.rewardAmountMinor,
        currency: computed.currency,
        qualifyingInvoicePublicId: event.invoicePublicId,
        qualifyingOrderPublicId: event.orderPublicId,
        invoiceSubtotalMinor: event.subtotalMinor,
        invoiceDiscountMinor: event.discountMinor,
        invoiceTotalMinor: event.totalMinor,
        invoiceCurrency: event.currency.trim().toUpperCase(),
        qualificationNoteCode: computed.qualificationNoteCode,
        qualifiedAt: now,
        ...(canAutoApprove
          ? {
              reviewedAt: now,
              reviewReason: "Automatically approved under referral programme policy.",
            }
          : {}),
        version: row.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(referrals.id, row.id),
          eq(referrals.status, "attributed"),
          eq(referrals.version, row.version),
        ),
      );

    if (affectedRows(updateRes) !== 1) {
      throw conflict("REFERRAL_CAS_CONFLICT", "Referral state changed concurrently.");
    }

    await deps.audit.record(
      {
        category: "business",
        eventName: "referral.qualified",
        action: "transition",
        outcome: "completed",
        actor: { role: "system" },
        resource: { type: "referral", publicId: row.publicId },
        attributes: {
          invoice_public_id: event.invoicePublicId,
          order_public_id: event.orderPublicId,
          reward_mode: computed.rewardMode,
          reward_amount_minor: computed.rewardAmountMinor,
          currency: computed.currency,
          next_status: nextStatus,
          qualification_note: computed.qualificationNoteCode,
        },
      },
      tx,
    );

    if (canAutoApprove) {
      const ledgerPublicId = ulid();
      await tx.insert(referralRewardLedger).values({
        publicId: ledgerPublicId,
        referralId: row.id,
        referrerUserId: row.referrerUserId,
        entryType: "reward_approved",
        amountMinor: computed.rewardAmountMinor,
        currency: computed.currency,
        reference: event.invoicePublicId,
        note: "Auto-approved on referred customer first paid invoice.",
        actorUserId: null,
        createdAt: now,
      });

      await deps.audit.record(
        {
          category: "admin",
          eventName: "referral.approved",
          action: "transition",
          outcome: "completed",
          actor: { role: "system" },
          resource: { type: "referral", publicId: row.publicId },
          attributes: {
            ledger_public_id: ledgerPublicId,
            reward_amount_minor: computed.rewardAmountMinor,
            currency: computed.currency,
            auto_approved: true,
          },
        },
        tx,
      );
    }

    const engagementSvc = (deps.services as Partial<typeof deps.services>).engagement;
    if (engagementSvc && typeof engagementSvc.notify === "function") {
      await engagementSvc.notify(
        {
          userId: row.referrerUserId,
          kind: canAutoApprove ? "referral.approved" : "referral.qualified",
          title: canAutoApprove
            ? "Referral reward approved"
            : "A referral qualified for review",
          body: canAutoApprove
            ? "A customer you referred completed their first paid invoice and your referral reward was approved."
            : "A customer you referred completed their first paid invoice and your referral is pending review.",
          link: "/account/referrals",
          idempotencyKey: `referral-qualified:${row.publicId}:${event.invoicePublicId}`,
          skipEmail: true,
        },
        tx,
      );
    }

    return {
      outcome: canAutoApprove ? "auto_approved" : "qualified_pending_approval",
      referralPublicId: row.publicId,
      rewardAmountMinor: computed.rewardAmountMinor,
      currency: computed.currency,
    };
  }

  async function onInvoicePaid(
    event: InvoicePaidReferralEvent,
    opts?: { tx?: Tx },
  ): Promise<OnInvoicePaidReferralResult> {
    if (opts?.tx) {
      return onInvoicePaidInTx(opts.tx, event);
    }
    return deps.db.transaction((tx) => onInvoicePaidInTx(tx, event));
  }

  /* ------------------------------------------------------ customer endpoints */

  async function customerOverview(
    principal: SessionPrincipal,
  ): Promise<CustomerReferralOverviewView> {
    await assertCustomerProgramAccess(principal);
    const codeRow = await ensureCustomerReferralCode(principal.userId);
    const config = await readSetting(deps.settings, REFERRALS_PROGRAM_CONFIG);
    const { sharePath, shareUrl } = buildShareLinks(codeRow.code);

    const statusRows = await deps.db
      .select({
        status: referrals.status,
        rowCount: count(),
        sumMinor: sql<number>`COALESCE(SUM(${referrals.rewardAmountMinor}), 0)`,
      })
      .from(referrals)
      .where(eq(referrals.referrerUserId, principal.userId))
      .groupBy(referrals.status);

    let total = 0;
    let pending = 0;
    let approved = 0;
    let credited = 0;
    let rejected = 0;
    let approvedRewardMinor = 0;
    let creditedRewardMinor = 0;

    for (const r of statusRows) {
      const n = Number(r.rowCount ?? 0);
      const sum = Number(r.sumMinor ?? 0);
      total += n;
      if (r.status === "attributed" || r.status === "qualified_pending_approval") {
        pending += n;
      } else if (r.status === "approved") {
        approved += n;
        approvedRewardMinor += sum;
      } else if (r.status === "credited") {
        credited += n;
        approvedRewardMinor += sum;
        creditedRewardMinor += sum;
      } else if (r.status === "rejected") {
        rejected += n;
      }
    }

    return {
      code: codeRow.code,
      shareUrl,
      sharePath,
      program: {
        rewardMode: config.rewardMode,
        fixedAmountMinor: config.fixedAmountMinor,
        percentBps: config.percentBps,
        capAmountMinor: config.capAmountMinor,
        currency: config.currency,
        manualApprovalRequired: config.manualApprovalRequired,
      },
      stats: {
        total,
        pending,
        approved: approved + credited,
        credited,
        rejected,
        approvedRewardMinor,
        creditedRewardMinor,
        currency: config.currency,
      },
    };
  }

  async function customerHistory(
    principal: SessionPrincipal,
    input: { cursor?: string; limit?: number },
  ): Promise<CursorPage<CustomerReferralHistoryItemView>> {
    await assertCustomerProgramAccess(principal);
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const cursorId = input.cursor ? decodeIdCursor(input.cursor) : null;

    const conditions = [eq(referrals.referrerUserId, principal.userId)];
    if (cursorId !== null) {
      conditions.push(lt(referrals.id, cursorId));
    }

    const rows = await deps.db
      .select()
      .from(referrals)
      .where(and(...conditions))
      .orderBy(desc(referrals.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const referredUsers = await loadUsersByIds(
      deps.db,
      pageRows.map((r) => r.referredUserId),
    );

    const items: CustomerReferralHistoryItemView[] = pageRows.map((r) => {
      const referred = referredUsers.get(r.referredUserId);
      return {
        referralPublicId: r.publicId,
        referredAccountHint: maskReferredCustomerHint(
          referred?.customerRef ?? null,
          referred?.publicId ?? r.publicId,
        ),
        status: r.status,
        rewardAmountMinor:
          r.status === "approved" || r.status === "credited" || r.status === "qualified_pending_approval"
            ? r.rewardAmountMinor
            : 0,
        currency: r.currency,
        attributedAt: r.attributedAt,
        qualifiedAt: r.qualifiedAt,
        reviewedAt: r.reviewedAt,
        creditedAt: r.creditedAt,
      };
    });

    const last = pageRows[pageRows.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeIdCursor(last.id) : null,
    };
  }

  /**
   * "E-mail my link" — spam-relay hardened:
   * - Active verified customer only (`protectedProcedure` + live actor check in `tx`).
   * - Server-derived sender name, referral code, and canonical link (zero free-form sender text or URLs).
   * - Enforces durable per-customer (24h + 10m burst) and per-recipient (cooldown window across ALL customers)
   *   rate limits via HMAC blind index.
   * - Refuses self-referral & `+alias` self-email.
   * - Silently suppresses already-registered platform accounts (`{ accepted: true }`) to avoid account enumeration.
   */
  async function sendInviteEmail(
    principal: SessionPrincipal,
    input: { recipientEmail: string },
  ): Promise<{ accepted: true }> {
    const normalizedRecipient = normalizeReferralEmail(input.recipientEmail);
    if (
      normalizedRecipient.length < 5 ||
      normalizedRecipient.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedRecipient)
    ) {
      throw validation("INVALID_EMAIL", "Enter a valid recipient e-mail address.", {
        field: "recipientEmail",
      });
    }

    const edgeVerdict = await deps.rateLimiter.consume(
      "form_submission",
      `referrals.invite:${principal.userPublicId}`,
    );
    if (!edgeVerdict.allowed) {
      throw new DomainError(
        "RATE_LIMITED",
        "INVITE_SENDER_RATE_LIMITED",
        "Too many referral invitations sent recently. Please wait before sending another.",
        { retryAfterSeconds: edgeVerdict.retryAfterSeconds },
      );
    }

    const recipientEmailIndex = deps.crypto.blindIndex(
      canonicalEmailIdentity(normalizedRecipient),
      "referrals.invite_recipient",
    );

    return runReferralsTx(
      deps,
      principal,
      { type: "referral_invite", publicId: principal.userPublicId },
      async (tx) => {
        await assertLiveActorInTx(deps, principal, tx);
        const sender = await assertCustomerProgramAccess(principal, tx);

        if (canonicalEmailIdentity(sender.email) === canonicalEmailIdentity(normalizedRecipient)) {
          throw validation(
            "SELF_REFERRAL",
            "You cannot send a referral invitation to your own e-mail address.",
            { field: "recipientEmail" },
          );
        }

        const config = await readSetting(deps.settings, REFERRALS_PROGRAM_CONFIG, tx);
        const now = deps.clock.now();
        const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
        const tenMinAgo = new Date(now.getTime() - 10 * 60_000);
        const recipientWindowStart = new Date(
          now.getTime() - config.inviteRecipientCooldownHours * 60 * 60_000,
        );

        const [senderDayRow] = await tx
          .select({ cnt: count() })
          .from(referralEmailInvites)
          .where(
            and(
              eq(referralEmailInvites.senderUserId, sender.userId),
              gte(referralEmailInvites.createdAt, dayAgo),
            ),
          );
        const senderDayCount = Number(senderDayRow?.cnt ?? 0);
        if (senderDayCount >= config.inviteMaxPerCustomerPerDay) {
          throw new DomainError(
            "RATE_LIMITED",
            "INVITE_SENDER_RATE_LIMITED",
            "You have reached the daily referral invitation limit. Please try again tomorrow.",
            { retryAfterSeconds: 3600 },
          );
        }

        const burstMax = Math.min(5, config.inviteMaxPerCustomerPerDay);
        const [senderBurstRow] = await tx
          .select({ cnt: count() })
          .from(referralEmailInvites)
          .where(
            and(
              eq(referralEmailInvites.senderUserId, sender.userId),
              gte(referralEmailInvites.createdAt, tenMinAgo),
            ),
          );
        if (Number(senderBurstRow?.cnt ?? 0) >= burstMax) {
          throw new DomainError(
            "RATE_LIMITED",
            "INVITE_SENDER_BURST_LIMITED",
            "Please wait a few minutes before sending more referral invitations.",
            { retryAfterSeconds: 600 },
          );
        }

        const [recipientWindowRow] = await tx
          .select({ cnt: count() })
          .from(referralEmailInvites)
          .where(
            and(
              eq(referralEmailInvites.recipientEmailIndex, recipientEmailIndex),
              gte(referralEmailInvites.createdAt, recipientWindowStart),
            ),
          );
        if (Number(recipientWindowRow?.cnt ?? 0) >= config.inviteMaxPerRecipientPerWindow) {
          throw new DomainError(
            "RATE_LIMITED",
            "INVITE_RECIPIENT_RATE_LIMITED",
            "An invitation was recently sent to this address or too many invitations were sent. Please try again later.",
            { retryAfterSeconds: 3600 },
          );
        }

        const codeRow = await ensureCustomerReferralCode(sender.userId, tx);
        if (!codeRow.active) {
          throw forbidden("REFERRAL_CODE_DISABLED");
        }

        const invitePublicId = ulid();
        const existingAccount = await findExistingUserByEmail(tx, normalizedRecipient);

        if (existingAccount) {
          await tx.insert(referralEmailInvites).values({
            publicId: invitePublicId,
            senderUserId: sender.userId,
            referralCodeId: codeRow.id,
            recipientEmailIndex,
            outcome: "suppressed_existing_user",
            createdAt: now,
          });
          await deps.audit.record(
            {
              category: "security",
              eventName: "referral.invite.refused",
              action: "refuse",
              outcome: "refused",
              severity: "INFO",
              reasonCode: "RECIPIENT_ALREADY_REGISTERED",
              actor: { userId: sender.userId, role: "customer" },
              resource: { type: "referral_invite", publicId: invitePublicId },
            },
            tx,
          );
          return { accepted: true };
        }

        const { shareUrl } = buildShareLinks(codeRow.code);
        await tx.insert(referralEmailInvites).values({
          publicId: invitePublicId,
          senderUserId: sender.userId,
          referralCodeId: codeRow.id,
          recipientEmailIndex,
          outcome: "enqueued",
          createdAt: now,
        });

        await deps.mailer.enqueue(
          {
            template: REFERRALS_INVITE_TEMPLATE_KEY,
            to: { address: normalizedRecipient },
            vars: {
              senderName: sanitizeSenderDisplayName(sender.name),
              referralCode: codeRow.code,
              referralLink: shareUrl,
            },
            idempotencyKey: `mail:referral-invite:${invitePublicId}`,
          },
          tx,
        );

        await deps.audit.record(
          {
            category: "business",
            eventName: "referral.invite.sent",
            action: "create",
            outcome: "completed",
            actor: { userId: sender.userId, role: "customer" },
            resource: { type: "referral_invite", publicId: invitePublicId },
            attributes: {
              referral_code_public_id: codeRow.publicId,
            },
          },
          tx,
        );

        return { accepted: true };
      },
      {
        onRefusalAfterRollback: async (err) => {
          if (
            err.reasonCode === "INVITE_SENDER_RATE_LIMITED" ||
            err.reasonCode === "INVITE_SENDER_BURST_LIMITED" ||
            err.reasonCode === "INVITE_RECIPIENT_RATE_LIMITED" ||
            err.reasonCode === "SELF_REFERRAL"
          ) {
            await deps.audit.record({
              category: "security",
              eventName: "referral.invite.refused",
              action: "refuse",
              outcome: "refused",
              severity: "WARN",
              reasonCode: err.reasonCode,
              actor: { userId: principal.userId, role: principal.role },
              resource: { type: "referral_account", publicId: principal.userPublicId },
            });
          }
        },
      },
    );
  }

  /* --------------------------------------------------- admin/staff endpoints */

  async function adminGetSettings(
    principal: SessionPrincipal,
  ): Promise<AdminReferralsSettingsView> {
    await assertStaffReadCapability(principal);
    const [enabled, config, statusCounts] = await Promise.all([
      isFlagEnabled(deps.settings, REFERRALS_ENABLED_FLAG),
      readSetting(deps.settings, REFERRALS_PROGRAM_CONFIG),
      deps.db
        .select({
          status: referrals.status,
          rowCount: count(),
          sumMinor: sql<number>`COALESCE(SUM(${referrals.rewardAmountMinor}), 0)`,
        })
        .from(referrals)
        .groupBy(referrals.status),
    ]);

    let totalReferrals = 0;
    let pendingApproval = 0;
    let approvedAwaitingCredit = 0;
    let creditedCount = 0;
    let approvedAmountMinor = 0;
    let creditedAmountMinor = 0;

    for (const r of statusCounts) {
      const cnt = Number(r.rowCount ?? 0);
      const sum = Number(r.sumMinor ?? 0);
      totalReferrals += cnt;
      if (r.status === "qualified_pending_approval") {
        pendingApproval += cnt;
      } else if (r.status === "approved") {
        approvedAwaitingCredit += cnt;
        approvedAmountMinor += sum;
      } else if (r.status === "credited") {
        creditedCount += cnt;
        approvedAmountMinor += sum;
        creditedAmountMinor += sum;
      }
    }

    return {
      enabled,
      config,
      summary: {
        totalReferrals,
        pendingApproval,
        approvedAwaitingCredit,
        creditedCount,
        approvedAmountMinor,
        creditedAmountMinor,
        currency: config.currency,
      },
    };
  }

  async function adminUpdateSettings(
    principal: SessionPrincipal,
    input: {
      enabled: boolean;
      config: ReferralProgramConfig;
    },
  ): Promise<AdminReferralsSettingsView> {
    await runReferralsTx(
      deps,
      principal,
      { type: "referrals_settings" },
      async (tx) => {
        const liveActor = await assertLiveActorInTx(deps, principal, tx, "referrals.manage");
        const prevEnabled = await isFlagEnabled(deps.settings, REFERRALS_ENABLED_FLAG, tx);
        const prevConfig = await readSetting(deps.settings, REFERRALS_PROGRAM_CONFIG, tx);

        await deps.settings.set(REFERRALS_ENABLED_FLAG.key, input.enabled, tx);
        await writeSetting(deps.settings, REFERRALS_PROGRAM_CONFIG, input.config, tx);

        await deps.audit.record(
          {
            category: "admin",
            eventName: "referral.program.updated",
            action: "update",
            outcome: "completed",
            actor: { userId: liveActor.userId, role: liveActor.role },
            resource: { type: "referrals_settings" },
            attributes: {
              previous_enabled: prevEnabled,
              enabled: input.enabled,
              previous_reward_mode: prevConfig.rewardMode,
              reward_mode: input.config.rewardMode,
              fixed_amount_minor: input.config.fixedAmountMinor,
              percent_bps: input.config.percentBps,
              cap_amount_minor: input.config.capAmountMinor,
              currency: input.config.currency,
              manual_approval_required: input.config.manualApprovalRequired,
              invite_max_per_customer_day: input.config.inviteMaxPerCustomerPerDay,
              invite_max_per_recipient_window: input.config.inviteMaxPerRecipientPerWindow,
            },
          },
          tx,
        );
      },
    );

    return adminGetSettings(principal);
  }

  function buildAdminFilterConditions(input: {
    status?: ReferralStatus;
    query?: string;
    from?: Date;
    to?: Date;
    cursorId?: number | null;
  }) {
    const conditions = [];
    if (input.status) {
      conditions.push(eq(referrals.status, input.status));
    }
    if (input.query) {
      const q = input.query.trim().toUpperCase();
      if (ULID_PATTERN.test(q)) {
        conditions.push(eq(referrals.publicId, q));
      } else if (/^[A-Z0-9]{2,10}$/.test(q)) {
        conditions.push(eq(referrals.codeSnapshot, q));
      } else {
        // Non-matching safe sentinel when query cannot match any ULID or code
        conditions.push(eq(referrals.id, 0));
      }
    }
    if (input.from) {
      conditions.push(gte(referrals.createdAt, input.from));
    }
    if (input.to) {
      conditions.push(lte(referrals.createdAt, input.to));
    }
    if (input.cursorId !== undefined && input.cursorId !== null) {
      conditions.push(lt(referrals.id, input.cursorId));
    }
    return conditions;
  }

  async function hydrateAdminReferralItems(
    dbOrTx: DbOrTx,
    rows: readonly ReferralRow[],
  ): Promise<AdminReferralItemView[]> {
    const userIds: number[] = [];
    for (const r of rows) {
      userIds.push(r.referrerUserId, r.referredUserId);
    }
    const userMap = await loadUsersByIds(dbOrTx, userIds);
    return rows.map((r) => {
      const referrer = userMap.get(r.referrerUserId);
      const referred = userMap.get(r.referredUserId);
      return {
        referralPublicId: r.publicId,
        codeSnapshot: r.codeSnapshot,
        status: r.status,
        referrerPublicId: referrer?.publicId ?? "unknown",
        referrerCustomerRef: referrer?.customerRef ?? null,
        referrerName: referrer?.name ?? "Unknown customer",
        referredPublicId: referred?.publicId ?? "unknown",
        referredCustomerRef: referred?.customerRef ?? null,
        referredName: referred?.name ?? "Unknown customer",
        rewardMode: r.rewardMode,
        rewardPercentBps: r.rewardPercentBps,
        rewardCapMinor: r.rewardCapMinor,
        rewardAmountMinor: r.rewardAmountMinor,
        currency: r.currency,
        qualifyingInvoicePublicId: r.qualifyingInvoicePublicId,
        qualifyingOrderPublicId: r.qualifyingOrderPublicId,
        invoiceTotalMinor: r.invoiceTotalMinor,
        invoiceCurrency: r.invoiceCurrency,
        qualificationNoteCode: r.qualificationNoteCode,
        attributedAt: r.attributedAt,
        qualifiedAt: r.qualifiedAt,
        reviewedAt: r.reviewedAt,
        reviewReason: r.reviewReason,
        creditedAt: r.creditedAt,
        payoutMethod: r.payoutMethod,
        payoutReference: r.payoutReference,
        payoutNote: r.payoutNote,
        version: r.version,
      };
    });
  }

  async function adminList(
    principal: SessionPrincipal,
    input: {
      status?: ReferralStatus;
      query?: string;
      from?: Date;
      to?: Date;
      cursor?: string;
      limit?: number;
    },
  ): Promise<CursorPage<AdminReferralItemView>> {
    await assertStaffReadCapability(principal);
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const cursorId = input.cursor ? decodeIdCursor(input.cursor) : null;
    const conditions = buildAdminFilterConditions({ ...input, cursorId });

    const rows = await deps.db
      .select()
      .from(referrals)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(referrals.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = await hydrateAdminReferralItems(deps.db, pageRows);
    const last = pageRows[pageRows.length - 1];

    return {
      items,
      nextCursor: hasMore && last ? encodeIdCursor(last.id) : null,
    };
  }

  async function adminLedger(
    principal: SessionPrincipal,
    input: {
      entryType?: ReferralLedgerEntryType;
      cursor?: string;
      limit?: number;
    },
  ): Promise<CursorPage<AdminRewardLedgerItemView>> {
    await assertStaffReadCapability(principal);
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const cursorId = input.cursor ? decodeIdCursor(input.cursor) : null;

    const conditions = [];
    if (input.entryType) {
      conditions.push(eq(referralRewardLedger.entryType, input.entryType));
    }
    if (cursorId !== null) {
      conditions.push(lt(referralRewardLedger.id, cursorId));
    }

    const rows = await deps.db
      .select({
        id: referralRewardLedger.id,
        ledgerPublicId: referralRewardLedger.publicId,
        referralPublicId: referrals.publicId,
        referrerUserId: referralRewardLedger.referrerUserId,
        entryType: referralRewardLedger.entryType,
        amountMinor: referralRewardLedger.amountMinor,
        currency: referralRewardLedger.currency,
        payoutMethod: referralRewardLedger.payoutMethod,
        reference: referralRewardLedger.reference,
        note: referralRewardLedger.note,
        createdAt: referralRewardLedger.createdAt,
      })
      .from(referralRewardLedger)
      .innerJoin(referrals, eq(referralRewardLedger.referralId, referrals.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(referralRewardLedger.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const userMap = await loadUsersByIds(
      deps.db,
      pageRows.map((r) => r.referrerUserId),
    );

    const items: AdminRewardLedgerItemView[] = pageRows.map((r) => {
      const referrer = userMap.get(r.referrerUserId);
      return {
        ledgerPublicId: r.ledgerPublicId,
        referralPublicId: r.referralPublicId,
        referrerPublicId: referrer?.publicId ?? "unknown",
        referrerCustomerRef: referrer?.customerRef ?? null,
        referrerName: referrer?.name ?? "Unknown customer",
        entryType: r.entryType,
        amountMinor: r.amountMinor,
        currency: r.currency,
        payoutMethod: r.payoutMethod,
        reference: r.reference,
        note: r.note,
        createdAt: r.createdAt,
      };
    });

    const last = pageRows[pageRows.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeIdCursor(last.id) : null,
    };
  }

  async function adminApprove(
    principal: SessionPrincipal,
    input: {
      referralPublicId: string;
      expectedVersion: number;
      overrideAmountMinor?: number;
      note?: string;
    },
  ): Promise<AdminReferralItemView> {
    return runReferralsTx(
      deps,
      principal,
      { type: "referral", publicId: input.referralPublicId },
      async (tx) => {
        const liveActor = await assertLiveActorInTx(deps, principal, tx, "referrals.manage");

        const [row] = await tx
          .select()
          .from(referrals)
          .where(eq(referrals.publicId, input.referralPublicId))
          .for("update")
          .limit(1);

        if (!row) {
          throw notFound("REFERRAL_NOT_FOUND");
        }
        if (row.version !== input.expectedVersion) {
          throw conflict(
            "VERSION_CONFLICT",
            "This referral was updated by another administrator. Refresh and try again.",
          );
        }
        if (row.status !== "qualified_pending_approval") {
          throw conflict(
            "INVALID_REFERRAL_TRANSITION",
            "Only qualified referrals awaiting approval can be approved.",
          );
        }
        if (
          row.qualificationNoteCode === "CURRENCY_MISMATCH" &&
          input.overrideAmountMinor === undefined
        ) {
          throw validation(
            "CURRENCY_MISMATCH_AMOUNT_REQUIRED",
            "Specify the approved reward amount in the programme currency before approving a cross-currency invoice referral.",
            { field: "overrideAmountMinor" },
          );
        }

        const approvedMinor = input.overrideAmountMinor ?? row.rewardAmountMinor;
        if (!Number.isSafeInteger(approvedMinor) || approvedMinor <= 0) {
          throw validation(
            "REWARD_AMOUNT_MUST_BE_POSITIVE",
            "Approved reward amount must be greater than zero minor units.",
            { field: "overrideAmountMinor" },
          );
        }

        const now = deps.clock.now();
        const trimmedNote = input.note?.trim() ? input.note.trim() : null;

        const updateRes = await tx
          .update(referrals)
          .set({
            status: "approved",
            rewardAmountMinor: approvedMinor,
            reviewedAt: now,
            reviewedByUserId: liveActor.userId,
            reviewReason: trimmedNote,
            version: row.version + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(referrals.id, row.id),
              eq(referrals.status, "qualified_pending_approval"),
              eq(referrals.version, row.version),
            ),
          );

        if (affectedRows(updateRes) !== 1) {
          throw conflict("REFERRAL_CAS_CONFLICT", "Referral state changed concurrently.");
        }

        const ledgerPublicId = ulid();
        await tx.insert(referralRewardLedger).values({
          publicId: ledgerPublicId,
          referralId: row.id,
          referrerUserId: row.referrerUserId,
          entryType: "reward_approved",
          amountMinor: approvedMinor,
          currency: row.currency,
          reference: row.qualifyingInvoicePublicId,
          note: trimmedNote,
          actorUserId: liveActor.userId,
          createdAt: now,
        });

        await deps.audit.record(
          {
            category: "admin",
            eventName: "referral.approved",
            action: "transition",
            outcome: "completed",
            actor: { userId: liveActor.userId, role: liveActor.role },
            resource: { type: "referral", publicId: row.publicId },
            attributes: {
              ledger_public_id: ledgerPublicId,
              reward_amount_minor: approvedMinor,
              currency: row.currency,
              auto_approved: false,
            },
          },
          tx,
        );

        const engagementSvc = (deps.services as Partial<typeof deps.services>).engagement;
        if (engagementSvc && typeof engagementSvc.notify === "function") {
          await engagementSvc.notify(
            {
              userId: row.referrerUserId,
              kind: "referral.approved",
              title: "Referral reward approved",
              body: "Your referral reward has been approved and added to your reward ledger.",
              link: "/account/referrals",
              idempotencyKey: `referral-approved:${row.publicId}`,
              skipEmail: true,
            },
            tx,
          );
        }

        const [updated] = await tx
          .select()
          .from(referrals)
          .where(eq(referrals.id, row.id))
          .limit(1);
        const [view] = await hydrateAdminReferralItems(tx, updated ? [updated] : [row]);
        return view!;
      },
    );
  }

  async function adminReject(
    principal: SessionPrincipal,
    input: {
      referralPublicId: string;
      expectedVersion: number;
      reason: string;
    },
  ): Promise<AdminReferralItemView> {
    const trimmedReason = input.reason.trim();
    if (trimmedReason.length < 3) {
      throw validation("REASON_REQUIRED", "Provide a rejection reason of at least 3 characters.", {
        field: "reason",
      });
    }

    return runReferralsTx(
      deps,
      principal,
      { type: "referral", publicId: input.referralPublicId },
      async (tx) => {
        const liveActor = await assertLiveActorInTx(deps, principal, tx, "referrals.manage");

        const [row] = await tx
          .select()
          .from(referrals)
          .where(eq(referrals.publicId, input.referralPublicId))
          .for("update")
          .limit(1);

        if (!row) {
          throw notFound("REFERRAL_NOT_FOUND");
        }
        if (row.version !== input.expectedVersion) {
          throw conflict(
            "VERSION_CONFLICT",
            "This referral was updated by another administrator. Refresh and try again.",
          );
        }
        if (row.status !== "attributed" && row.status !== "qualified_pending_approval") {
          throw conflict(
            "INVALID_REFERRAL_TRANSITION",
            "Only attributed or pending referrals can be rejected.",
          );
        }

        const now = deps.clock.now();
        const updateRes = await tx
          .update(referrals)
          .set({
            status: "rejected",
            reviewedAt: now,
            reviewedByUserId: liveActor.userId,
            reviewReason: trimmedReason,
            version: row.version + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(referrals.id, row.id),
              eq(referrals.status, row.status),
              eq(referrals.version, row.version),
            ),
          );

        if (affectedRows(updateRes) !== 1) {
          throw conflict("REFERRAL_CAS_CONFLICT", "Referral state changed concurrently.");
        }

        await deps.audit.record(
          {
            category: "admin",
            eventName: "referral.rejected",
            action: "transition",
            outcome: "completed",
            actor: { userId: liveActor.userId, role: liveActor.role },
            resource: { type: "referral", publicId: row.publicId },
            attributes: {
              previous_status: row.status,
            },
          },
          tx,
        );

        const [updated] = await tx
          .select()
          .from(referrals)
          .where(eq(referrals.id, row.id))
          .limit(1);
        const [view] = await hydrateAdminReferralItems(tx, updated ? [updated] : [row]);
        return view!;
      },
    );
  }

  async function adminMarkCredited(
    principal: SessionPrincipal,
    input: {
      referralPublicId: string;
      expectedVersion: number;
      payoutMethod: ReferralPayoutMethod;
      reference: string;
      note?: string;
    },
  ): Promise<AdminReferralItemView> {
    const trimmedRef = input.reference.trim();
    if (trimmedRef.length < 2) {
      throw validation(
        "REFERENCE_REQUIRED",
        "Enter the credit or payout reference (for example invoice number or credit memo ID).",
        { field: "reference" },
      );
    }

    return runReferralsTx(
      deps,
      principal,
      { type: "referral", publicId: input.referralPublicId },
      async (tx) => {
        const liveActor = await assertLiveActorInTx(deps, principal, tx, "referrals.manage");

        const [row] = await tx
          .select()
          .from(referrals)
          .where(eq(referrals.publicId, input.referralPublicId))
          .for("update")
          .limit(1);

        if (!row) {
          throw notFound("REFERRAL_NOT_FOUND");
        }
        if (row.version !== input.expectedVersion) {
          throw conflict(
            "VERSION_CONFLICT",
            "This referral was updated by another administrator. Refresh and try again.",
          );
        }
        if (row.status !== "approved") {
          throw conflict(
            "INVALID_REFERRAL_TRANSITION",
            "Only approved referrals can be marked credited or paid.",
          );
        }

        const now = deps.clock.now();
        const trimmedNote = input.note?.trim() ? input.note.trim() : null;

        const updateRes = await tx
          .update(referrals)
          .set({
            status: "credited",
            creditedAt: now,
            creditedByUserId: liveActor.userId,
            payoutMethod: input.payoutMethod,
            payoutReference: trimmedRef,
            payoutNote: trimmedNote,
            version: row.version + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(referrals.id, row.id),
              eq(referrals.status, "approved"),
              eq(referrals.version, row.version),
            ),
          );

        if (affectedRows(updateRes) !== 1) {
          throw conflict("REFERRAL_CAS_CONFLICT", "Referral state changed concurrently.");
        }

        const ledgerPublicId = ulid();
        await tx.insert(referralRewardLedger).values({
          publicId: ledgerPublicId,
          referralId: row.id,
          referrerUserId: row.referrerUserId,
          entryType: "credit_applied",
          amountMinor: row.rewardAmountMinor,
          currency: row.currency,
          payoutMethod: input.payoutMethod,
          reference: trimmedRef,
          note: trimmedNote,
          actorUserId: liveActor.userId,
          createdAt: now,
        });

        await deps.audit.record(
          {
            category: "admin",
            eventName: "referral.credited",
            action: "transition",
            outcome: "completed",
            actor: { userId: liveActor.userId, role: liveActor.role },
            resource: { type: "referral", publicId: row.publicId },
            attributes: {
              ledger_public_id: ledgerPublicId,
              payout_method: input.payoutMethod,
              reward_amount_minor: row.rewardAmountMinor,
              currency: row.currency,
            },
          },
          tx,
        );

        const engagementSvc = (deps.services as Partial<typeof deps.services>).engagement;
        if (engagementSvc && typeof engagementSvc.notify === "function") {
          await engagementSvc.notify(
            {
              userId: row.referrerUserId,
              kind: "referral.credited",
              title: "Referral credit applied",
              body: "Your approved referral credit has been applied to your account.",
              link: "/account/referrals",
              idempotencyKey: `referral-credited:${row.publicId}`,
              skipEmail: true,
            },
            tx,
          );
        }

        const [updated] = await tx
          .select()
          .from(referrals)
          .where(eq(referrals.id, row.id))
          .limit(1);
        const [view] = await hydrateAdminReferralItems(tx, updated ? [updated] : [row]);
        return view!;
      },
    );
  }

  async function adminExport(
    principal: SessionPrincipal,
    input: {
      format: "csv" | "json";
      status?: ReferralStatus;
      query?: string;
      from?: Date;
      to?: Date;
    },
  ): Promise<{
    filename: string;
    contentType: string;
    rowCount: number;
    body: string;
  }> {
    return runReferralsTx(
      deps,
      principal,
      { type: "referrals_export" },
      async (tx) => {
        const liveActor = await assertLiveActorInTx(deps, principal, tx, "referrals.manage");
        const conditions = buildAdminFilterConditions(input);
        const rows = await tx
          .select()
          .from(referrals)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(referrals.id))
          .limit(2_000);

        const hydrated = await hydrateAdminReferralItems(tx, rows);
        const dateStamp = deps.clock.now().toISOString().slice(0, 10);

        await deps.audit.record(
          {
            category: "admin",
            eventName: "referrals.exported",
            action: "export",
            outcome: "completed",
            actor: { userId: liveActor.userId, role: liveActor.role },
            resource: { type: "referrals_export" },
            safeCounts: { rows: hydrated.length },
            attributes: {
              format: input.format,
              status_filter: input.status ?? "all",
            },
          },
          tx,
        );

        if (input.format === "json") {
          const payload = hydrated.map((item) => ({
            referralPublicId: item.referralPublicId,
            code: item.codeSnapshot,
            status: item.status,
            referrerPublicId: item.referrerPublicId,
            referrerCustomerRef: item.referrerCustomerRef,
            referredPublicId: item.referredPublicId,
            referredCustomerRef: item.referredCustomerRef,
            rewardMode: item.rewardMode,
            rewardAmountMinor: item.rewardAmountMinor,
            currency: item.currency,
            qualifyingInvoicePublicId: item.qualifyingInvoicePublicId,
            qualifyingOrderPublicId: item.qualifyingOrderPublicId,
            attributedAt: item.attributedAt.toISOString(),
            qualifiedAt: item.qualifiedAt?.toISOString() ?? null,
            reviewedAt: item.reviewedAt?.toISOString() ?? null,
            reviewReason: item.reviewReason,
            creditedAt: item.creditedAt?.toISOString() ?? null,
            payoutMethod: item.payoutMethod,
            payoutReference: item.payoutReference,
          }));
          return {
            filename: `readypackets-referrals-${dateStamp}.json`,
            contentType: "application/json; charset=utf-8",
            rowCount: hydrated.length,
            body: JSON.stringify({ exportedAt: deps.clock.now().toISOString(), items: payload }, null, 2),
          };
        }

        const headers = [
          "referral_public_id",
          "code",
          "status",
          "referrer_public_id",
          "referrer_customer_ref",
          "referred_public_id",
          "referred_customer_ref",
          "reward_mode",
          "reward_amount_minor",
          "currency",
          "qualifying_invoice_public_id",
          "qualifying_order_public_id",
          "attributed_at",
          "qualified_at",
          "reviewed_at",
          "review_reason",
          "credited_at",
          "payout_method",
          "payout_reference",
        ] as const;

        const csvRows = hydrated.map((item) => [
          item.referralPublicId,
          item.codeSnapshot,
          item.status,
          item.referrerPublicId,
          item.referrerCustomerRef,
          item.referredPublicId,
          item.referredCustomerRef,
          item.rewardMode,
          item.rewardAmountMinor,
          item.currency,
          item.qualifyingInvoicePublicId,
          item.qualifyingOrderPublicId,
          item.attributedAt.toISOString(),
          item.qualifiedAt?.toISOString() ?? null,
          item.reviewedAt?.toISOString() ?? null,
          item.reviewReason,
          item.creditedAt?.toISOString() ?? null,
          item.payoutMethod,
          item.payoutReference,
        ]);

        return {
          filename: `readypackets-referrals-${dateStamp}.csv`,
          contentType: "text/csv; charset=utf-8",
          rowCount: hydrated.length,
          body: serializeSafeCsv(headers, csvRows),
        };
      },
    );
  }

  async function healthCounts(): Promise<{ enabled: boolean; totalReferrals: number }> {
    const [enabled, [cntRow]] = await Promise.all([
      isFlagEnabled(deps.settings, REFERRALS_ENABLED_FLAG),
      deps.db.select({ cnt: count() }).from(referrals),
    ]);
    return {
      enabled,
      totalReferrals: Number(cntRow?.cnt ?? 0),
    };
  }

  return {
    publicStatus,
    validateCode,
    attributeRegistration,
    onInvoicePaid,
    customerOverview,
    customerHistory,
    sendInviteEmail,
    adminGetSettings,
    adminUpdateSettings,
    adminList,
    adminLedger,
    adminApprove,
    adminReject,
    adminMarkCredited,
    adminExport,
    healthCounts,
  };
}

export type ReferralsService = ReturnType<typeof createReferralsService>;
