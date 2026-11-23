/**
 * Increment 06 D7: sign-in step signals for the protection module (automatic bans, correlation).
 * Owner: identity_engineer. Port owner: http_security_engineer (`services.protection.recordSignInSignal`).
 *
 * Rules:
 * - The banned-IP precheck runs at the HTTP entry points (protection module), before these procedures.
 * - Called AFTER the business transaction committed or rolled back (never with an ambient tx).
 * - Never throws: a signal-write failure must not turn into a sign-in failure (or success).
 * - No e-mail, password, token or raw identifier in the signal: the account is a keyed blind index of the
 *   normalized e-mail (`protection.account_ref`), computed for unknown e-mails too so spraying can count
 *   distinct accounts. The IP is the trusted request-context address (after the proxy boundary).
 */
import type { ModuleDeps } from "../../container.js";
import { getRequestContext } from "../../core/requestContext.js";
import type { DbOrTx } from "../../core/types.js";
import { normalizeEmail } from "./normalize.js";
import { createUserRepo, emailAad } from "./users.js";

export const SIGN_IN_SIGNAL_KINDS = ["password", "mfa", "recovery_code", "passkey", "password_reset", "sso_callback"] as const;
export type SignInSignalKind = (typeof SIGN_IN_SIGNAL_KINDS)[number];
export type SignInSignalOutcome = "success" | "failure";
export const ACCOUNT_REF_PURPOSE = "protection.account_ref";

export interface SignInSignal {
  ip: string | null | undefined;
  accountRef?: string | undefined;
  kind: SignInSignalKind;
  outcome: SignInSignalOutcome;
  correlationId: string;
  at: Date;
}

interface ProtectionPort {
  recordSignInSignal?(input: SignInSignal): Promise<void>;
}

export function createSignInSignals(deps: ModuleDeps) {
  const repo = createUserRepo(deps);
  const port = (): ProtectionPort | undefined => (deps.services as unknown as { protection?: ProtectionPort }).protection;

  function accountRefForEmail(email: string): string | undefined {
    const normalized = normalizeEmail(email);
    return normalized ? deps.crypto.blindIndex(normalized, ACCOUNT_REF_PURPOSE) : undefined;
  }

  async function accountRefForUser(userId: number, opts: { tx?: DbOrTx } = {}): Promise<string | null> {
    const row = await repo.byId(userId, opts);
    return row ? (accountRefForEmail(deps.crypto.decrypt(row.emailEnc, emailAad(row.publicId))) ?? null) : null;
  }

  async function send(kind: SignInSignalKind, outcome: SignInSignalOutcome, accountRef: string | undefined): Promise<void> {
    const record = port()?.recordSignInSignal;
    if (!record) return;
    const ctx = getRequestContext();
    try {
      await record.call(port(), {
        ip: ctx?.ipAddress ?? null,
        ...(accountRef ? { accountRef } : {}),
        kind,
        outcome,
        correlationId: ctx?.correlationId ?? ctx?.requestId ?? "",
        at: deps.clock.now(),
      });
    } catch (error) {
      deps.logger.warn("identity.sign_in_signal.failed", { kind, outcome, errorName: error instanceof Error ? error.name : "unknown" });
    }
  }

  return {
    accountRefForEmail,
    accountRefForUser,
    /** By e-mail (password, reset request). Never throws. */
    async forEmail(kind: SignInSignalKind, outcome: SignInSignalOutcome, email: string | null | undefined): Promise<void> {
      let ref: string | undefined;
      try {
        ref = email ? accountRefForEmail(email) : undefined;
      } catch {
        ref = undefined;
      }
      await send(kind, outcome, ref);
    },
    /** By known user (MFA, recovery code, passkey, reset/activation link, SSO). Never throws. */
    async publish(input: { kind: SignInSignalKind; outcome: SignInSignalOutcome; userId?: number | null | undefined }): Promise<void> {
      let ref: string | undefined;
      try {
        ref = input.userId ? ((await accountRefForUser(input.userId)) ?? undefined) : undefined;
      } catch {
        ref = undefined;
      }
      await send(input.kind, input.outcome, ref);
    },
  };
}
export type SignInSignals = ReturnType<typeof createSignInSignals>;
