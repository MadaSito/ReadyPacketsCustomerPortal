/**
 * Increment 06 D11 — Shared server-side typed signature name verification.
 *
 * Used behind one implementation by:
 *   1. Account/portal/checkout/remediation policy acceptances (`policiesService.ts`)
 *   2. Workflow & order policy acceptance gates (`acceptance.ts`)
 *
 * Rules:
 *   - Setting `compliance.signature_name_check` `{ mode: "require" | "warn" | "off" }`, default `require`.
 *   - Comparison: Unicode NFKC, case-insensitive, diacritics and punctuation ignored, whitespace collapsed.
 *   - Accepted when the typed name equals the account's full name (`"exact"`), or first + last name with
 *     middle names omitted (`"first_last"`).
 *   - Mismatch attempts are audited (`compliance.signature_name.mismatch`) WITHOUT storing the typed text in clear.
 */
import { eq } from "drizzle-orm";
import type { UserRole } from "../../../shared/domain.js";
import type { ModuleDeps } from "../../container.js";
import { validation, type DomainError } from "../../core/errors.js";
import type { DbOrTx, Tx } from "../../core/types.js";
import { users } from "../identity/schema.js";
import { nameAad } from "../identity/users.js";
import type { SignatureNameMatchResult } from "./acceptanceSchema.js";
import {
  DEFAULT_SIGNATURE_NAME_CHECK_SETTING,
  parseSignatureNameCheckSetting,
  SIGNATURE_NAME_CHECK,
  type SignatureNameCheckMode,
} from "./settings.js";

const LATIN_FOLD_MAP: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
};

function foldDiacriticsAndCase(raw: string): string {
  const nfkc = raw.normalize("NFKC").toLowerCase();
  const decomposed = nfkc.normalize("NFD").replace(/\p{M}+/gu, "");
  return decomposed.replace(/[ßæœøłđðþ]/gu, (ch) => LATIN_FOLD_MAP[ch] ?? ch);
}

/**
 * Normalizes a name for D11 comparison:
 *  - Unicode NFKC + NFD combining-mark removal + lowercase
 *  - Intra-word apostrophes (`O'Connor`) stripped so `O'Connor` and `OConnor` match
 *  - All remaining punctuation and symbols replaced with spaces
 *  - Whitespace collapsed and trimmed
 */
export function normalizeSignatureName(raw: string): string {
  return foldDiacriticsAndCase(raw)
    .replace(/['’ʼ`´]/gu, "")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Splits a name by whitespace first (preserving hyphenated surname parts like `Smith-Jones` as one part),
 * then normalizes each non-empty part so first + last comparison omits middle names cleanly.
 */
export function splitNormalizedNameParts(raw: string): string[] {
  return raw
    .normalize("NFKC")
    .trim()
    .split(/\s+/gu)
    .map((part) => normalizeSignatureName(part))
    .filter((part) => part.length > 0);
}

export type PureSignatureComparison =
  | { matched: true; kind: "exact" | "first_last" }
  | { matched: false };

/**
 * Pure D11 comparison:
 *  - `"exact"` when full normalized typed name equals full normalized account name
 *  - `"first_last"` when account name has >= 3 name parts (middle name/initial present) and typed name
 *    equals `<first> <last>` (checked both by whitespace-delimited parts and normalized tokens).
 */
export function compareTypedSignatureToAccountName(
  typedName: string,
  accountName: string,
): PureSignatureComparison {
  const normTyped = normalizeSignatureName(typedName);
  const normAccount = normalizeSignatureName(accountName);
  if (!normTyped || !normAccount) {
    return { matched: false };
  }
  if (normTyped === normAccount) {
    return { matched: true, kind: "exact" };
  }

  const rawParts = splitNormalizedNameParts(accountName);
  if (rawParts.length >= 3) {
    const firstLastByPart = `${rawParts[0]} ${rawParts[rawParts.length - 1]}`.replace(/\s+/gu, " ").trim();
    if (normTyped === firstLastByPart) {
      return { matched: true, kind: "first_last" };
    }
  }

  const flatTokens = normAccount.split(" ").filter((t) => t.length > 0);
  if (flatTokens.length >= 3) {
    const firstLastByToken = `${flatTokens[0]} ${flatTokens[flatTokens.length - 1]}`;
    if (normTyped === firstLastByToken) {
      return { matched: true, kind: "first_last" };
    }
  }

  return { matched: false };
}

export async function readSignatureNameCheckMode(
  deps: ModuleDeps,
  dbOrTx?: DbOrTx,
): Promise<SignatureNameCheckMode> {
  try {
    const raw = await deps.settings.get(
      SIGNATURE_NAME_CHECK.key,
      parseSignatureNameCheckSetting,
      DEFAULT_SIGNATURE_NAME_CHECK_SETTING,
      dbOrTx ? (dbOrTx as Tx) : undefined,
    );
    return parseSignatureNameCheckSetting(raw).mode;
  } catch {
    return DEFAULT_SIGNATURE_NAME_CHECK_SETTING.mode;
  }
}

export interface EffectiveTypedSignatureGateSnapshot {
  readonly enabled: boolean;
  readonly policyPublicId: string | null;
  readonly signatureMode: "typed_name" | "checkbox";
}

const DEFAULT_TYPED_SIGNATURE_GATE_SNAPSHOT: EffectiveTypedSignatureGateSnapshot = {
  enabled: false,
  policyPublicId: null,
  signatureMode: "typed_name",
};

/**
 * Parses `orders.agreement_gate` with the same backward-compatible defaults as `orders/settings.ts`
 * (never throws; `signatureMode` defaults to `"typed_name"`).
 */
export function parseOrderAgreementGateSnapshot(raw: unknown): EffectiveTypedSignatureGateSnapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_TYPED_SIGNATURE_GATE_SNAPSHOT;
  }
  const obj = raw as Record<string, unknown>;
  const enabled = obj.enabled === true;
  const policyPublicId =
    typeof obj.policyPublicId === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(obj.policyPublicId)
      ? obj.policyPublicId
      : null;
  const signatureMode = obj.signatureMode === "checkbox" ? "checkbox" : "typed_name";
  return { enabled, policyPublicId, signatureMode };
}

export async function readOrderAgreementGateSnapshot(
  deps: Pick<ModuleDeps, "settings">,
  dbOrTx?: DbOrTx,
): Promise<EffectiveTypedSignatureGateSnapshot> {
  try {
    const raw = await deps.settings.get(
      "orders.agreement_gate",
      parseOrderAgreementGateSnapshot,
      DEFAULT_TYPED_SIGNATURE_GATE_SNAPSHOT,
      dbOrTx ? (dbOrTx as Tx) : undefined,
    );
    return parseOrderAgreementGateSnapshot(raw);
  } catch {
    return DEFAULT_TYPED_SIGNATURE_GATE_SNAPSHOT;
  }
}

/**
 * Single source of truth for the effective typed-signature requirement on a policy document:
 * true when the document's own `requiresTypedSignature` flag is true OR `orders.agreement_gate`
 * is enabled on `doc.publicId` with `signatureMode === "typed_name"`.
 */
export function resolveEffectiveRequiresTypedSignature(
  doc: { publicId: string; requiresTypedSignature: boolean },
  gate: EffectiveTypedSignatureGateSnapshot,
): boolean {
  return (
    doc.requiresTypedSignature ||
    (gate.enabled && gate.policyPublicId === doc.publicId && gate.signatureMode === "typed_name")
  );
}

export async function loadAccountDisplayName(
  deps: ModuleDeps,
  userId: number,
  dbOrTx?: DbOrTx,
): Promise<string | null> {
  const identitySvc = (deps.services as Partial<typeof deps.services>).identity;
  if (identitySvc?.getUser) {
    const view = await identitySvc.getUser(userId, dbOrTx ? { tx: dbOrTx as Tx } : undefined);
    if (view) return view.name;
  }
  const db = dbOrTx ?? deps.db;
  const [row] = await db
    .select({ publicId: users.publicId, nameEnc: users.nameEnc })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;
  return deps.crypto.decrypt(row.nameEnc, nameAad(row.publicId));
}

export interface VerifyTypedSignatureInput {
  tx: Tx;
  userId: number;
  actorRole: UserRole;
  typedName: string | undefined;
  requiredErrorCode?: string;
  requiredErrorMessage?: string;
  requiredField?: string;
  resource: { type: string; publicId: string };
}

export interface VerifiedTypedSignature {
  cleanedTypedName: string;
  accountName: string | null;
  matchResult: SignatureNameMatchResult;
}

/**
 * Validates presence/format of `typedName`, evaluates D11 against the user's live account name,
 * audits `"warn"` mismatches inside `tx` (without clear typed text), and throws `SIGNER_NAME_MISMATCH`
 * when `mode === "require"` (with `expectedName` + `profileUrl` details for the client).
 */
export async function verifyTypedSignatureInTx(
  deps: ModuleDeps,
  input: VerifyTypedSignatureInput,
): Promise<VerifiedTypedSignature> {
  const raw = input.typedName ?? "";
  const cleaned = raw.normalize("NFC").replace(/\s+/gu, " ").trim();
  const cpLen = [...cleaned].length;
  const versionPublicId =
    input.resource.type === "policy_version" ? input.resource.publicId : undefined;
  if (cpLen < 2 || cpLen > 160 || /[\p{Cc}\p{Cf}]/u.test(cleaned) || !/\p{L}/u.test(cleaned)) {
    const requiredDetails: Record<string, string> = {};
    if (input.requiredField) requiredDetails.field = input.requiredField;
    if (versionPublicId) requiredDetails.versionPublicId = versionPublicId;
    throw validation(
      input.requiredErrorCode ?? "TYPED_SIGNATURE_REQUIRED",
      input.requiredErrorMessage ?? "Please enter your full name to sign.",
      Object.keys(requiredDetails).length > 0 ? requiredDetails : undefined,
    );
  }

  const [mode, accountName] = await Promise.all([
    readSignatureNameCheckMode(deps, input.tx),
    loadAccountDisplayName(deps, input.userId, input.tx),
  ]);

  if (mode === "off") {
    return {
      cleanedTypedName: cleaned,
      accountName,
      matchResult: "skipped_off",
    };
  }

  if (!accountName) {
    if (mode === "warn") {
      await deps.audit.record(
        {
          category: "security",
          eventName: "compliance.signature_name.mismatch",
          action: "verify",
          outcome: "completed",
          severity: "WARN",
          reasonCode: "SIGNER_NAME_MISMATCH_WARN",
          actor: { userId: input.userId, role: input.actorRole },
          resource: input.resource,
          attributes: {
            check_mode: mode,
            typed_code_points: cpLen,
          },
        },
        input.tx,
      );
      return {
        cleanedTypedName: cleaned,
        accountName: null,
        matchResult: "mismatch_warn",
      };
    }
    const noAccountDetails: Record<string, string> = { profilePath: "/account" };
    if (versionPublicId) noAccountDetails.versionPublicId = versionPublicId;
    throw validation(
      "SIGNER_NAME_MISMATCH",
      "The typed signature must match your account profile name.",
      noAccountDetails,
    );
  }

  const comparison = compareTypedSignatureToAccountName(cleaned, accountName);
  if (comparison.matched) {
    return {
      cleanedTypedName: cleaned,
      accountName,
      matchResult: comparison.kind,
    };
  }

  if (mode === "warn") {
    await deps.audit.record(
      {
        category: "security",
        eventName: "compliance.signature_name.mismatch",
        action: "verify",
        outcome: "completed",
        severity: "WARN",
        reasonCode: "SIGNER_NAME_MISMATCH_WARN",
        actor: { userId: input.userId, role: input.actorRole },
        resource: input.resource,
        attributes: {
          check_mode: "warn",
          typed_code_points: cpLen,
        },
      },
      input.tx,
    );
    return {
      cleanedTypedName: cleaned,
      accountName,
      matchResult: "mismatch_warn",
    };
  }

  // `mode === "require"`: throw DomainError; caller's `onRefusalAfterRollback` records the durable audit
  // outside the rolled-back transaction WITHOUT storing the typed text in clear.
  const mismatchDetails: Record<string, string> = {
    expectedName: accountName,
    profilePath: "/account",
  };
  if (versionPublicId) mismatchDetails.versionPublicId = versionPublicId;
  throw validation(
    "SIGNER_NAME_MISMATCH",
    "The typed signature must match your account profile name.",
    mismatchDetails,
  );
}

/**
 * Records a durable denied audit event after transaction rollback when `verifyTypedSignatureInTx`
 * rejects a typed signature under `mode === "require"`. Never logs the typed text in clear.
 */
export async function recordSignatureMismatchAuditIfNeeded(
  deps: ModuleDeps,
  actor: { userId: number; role: UserRole },
  resource: { type: string; publicId: string },
  err: DomainError,
): Promise<void> {
  if (err.reasonCode !== "SIGNER_NAME_MISMATCH") return;
  await deps.audit.record({
    category: "security",
    eventName: "compliance.signature_name.mismatch",
    action: "verify",
    outcome: "denied",
    severity: "WARN",
    reasonCode: "SIGNER_NAME_MISMATCH",
    actor,
    resource,
    attributes: {
      check_mode: "require",
    },
  });
}
