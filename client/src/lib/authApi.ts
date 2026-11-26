/**
 * Narrow, explicitly typed facade over the identity + assurance tRPC procedures used by the auth/transition
 * screens, the route guard and useStepUp. Owner: UI foundation engineer.
 *
 * Why a facade: the screens were built in parallel with the identity/assurance routers. Signatures are taken
 * from server/modules/identity/API.md and server/modules/assurance/API.md (agreed by message). The calls go
 * through the real tRPC client (same transport, CSRF, batching). Once both routers are complete this file can
 * switch to the inferred AppRouter types without touching any screen. Tests inject a fake via AuthApiProvider.
 */
import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import type { TransitionStep, UserRole } from "@shared/domain";
import type { BillingDetailsInput } from "@shared/billingDetails";
import { useTRPCClient } from "./trpc";

export interface MeUser {
  publicId: string;
  role: UserRole;
  name: string;
  /** Increment 08 (D1). Derived for accounts from before 08 until the profile is saved. */
  firstName?: string;
  lastName?: string;
  preferredName?: string | null;
  /** Preferred name, else first name — use for greetings; legal/billing contexts keep `name`. */
  greetingName?: string;
  email: string;
  customerRef?: string | null;
  status: string;
}
export interface MeResult {
  user: MeUser;
  state: "full" | "remediation";
  pendingSteps: TransitionStep[];
  nextStep: TransitionStep | null;
  /** Server session policy for this session (identity_engineer). Optional until the server ships it. */
  session?: { idleTimeoutSeconds: number; absoluteExpiresAt: string };
}
export interface Accepted {
  accepted: true;
  /** Preview deployment profile only: delivery is not configured, so the link is returned for the demo. */
  previewLink?: string;
}
export type SecondFactorInput =
  | { method: "totp" | "recovery_code"; code: string }
  | { method: "passkey"; challengeId: string; response: unknown };
export interface AssuranceState {
  mfaEnrolled: boolean;
  recoveryCodesAcknowledged: boolean;
  passkeyCount: number;
  totpEnrolled: boolean;
  recoveryCodesRemaining: number;
}
export interface PasskeyChallenge {
  challengeId: string;
  /** PublicKeyCredentialRequestOptionsJSON — pass as `optionsJSON` to @simplewebauthn/browser. */
  options: unknown;
}

export interface PublicSlide {
  id: string;
  title: string;
  body: string;
  /** Same-origin path (allowlisted /brand/… asset or /api/platform/presentation/images/<id>). */
  image: { id: string; alt: string; url: string } | null;
}
export interface PublicPresentation {
  slides: PublicSlide[];
  slideshow: { autoAdvance: boolean; intervalSeconds: number };
  supportText: string;
  announcement: { text: string; tone: "info" | "warning" } | null;
  /** True when the server runs the preview profile (synthetic data only). */
  preview?: boolean;
}

export interface AuthApi {
  /** platform.presentation (public): sign-in slideshow + support text. */
  presentation(): Promise<PublicPresentation>;
  /** jobs.maintenanceBanner (public). */
  maintenanceBanner(): Promise<{ active: boolean; message: string | null }>;
  /** platform.bootstrap (public): client-visible feature switches (shell navigation `enabledBy`). */
  bootstrap(): Promise<{ features: Record<string, boolean> }>;
  me(): Promise<MeResult>;
  passwordPolicy(): Promise<{ minLength: number; maxLength: number }>;
  signIn(input: { email: string; password: string }): Promise<{ nextStep: TransitionStep | null }>;
  signOut(): Promise<unknown>;
  register(input: {
    email: string;
    firstName: string;
    lastName: string;
    preferredName?: string | null;
    password: string;
    acceptedPolicies?: string[];
    referralCode?: string;
    /** D4: optional billing information, saved only when a new account is created. */
    billing?: BillingDetailsInput | null;
  }): Promise<Accepted>;
  verifyEmail(input: { token: string }): Promise<unknown>;
  resendVerification(): Promise<Accepted>;
  requestPasswordReset(input: { email: string }): Promise<Accepted>;
  resetPassword(input: { token: string; password: string }): Promise<unknown>;
  activateAccount(input: { token: string; password: string }): Promise<unknown>;
  changePassword(input: { currentPassword: string; newPassword: string }): Promise<{ nextStep: TransitionStep | null }>;
  assuranceState(): Promise<AssuranceState>;
  beginTotpEnrollment(): Promise<{ secret: string; otpauthUri: string; qrDataUrl: string }>;
  confirmTotpEnrollment(input: { code: string }): Promise<{ recoveryCodes: string[] | null; recoverySetId: string | null }>;
  acknowledgeRecoveryCodes(input: { recoverySetId: string }): Promise<{ ok: true }>;
  recoverUnacknowledgedCodes(input: { factor: SecondFactorInput }): Promise<{ recoveryCodes: string[]; recoverySetId: string }>;
  beginPasskeyAuthentication(input: { purpose: "challenge" | "step_up" | "recovery_reissue" }): Promise<PasskeyChallenge>;
  challenge(input: SecondFactorInput): Promise<{ ok: true }>;
  stepUp(input: { password: string; factor: SecondFactorInput }): Promise<{ ok: true }>;
}

type Proc = { query?: (input?: unknown) => Promise<unknown>; mutate?: (input?: unknown) => Promise<unknown> };
type ProcTree = Record<string, Record<string, Proc>>;

export function createAuthApi(client: unknown): AuthApi {
  const c = client as ProcTree;
  const q = <T,>(ns: string, name: string, input?: unknown) => c[ns]![name]!.query!(input) as Promise<T>;
  const m = <T,>(ns: string, name: string, input?: unknown) => c[ns]![name]!.mutate!(input) as Promise<T>;
  return {
    presentation: () => q("platform", "presentation"),
    maintenanceBanner: () => q("jobs", "maintenanceBanner"),
    bootstrap: () => q("platform", "bootstrap"),
    me: () => q("identity", "me"),
    passwordPolicy: () => q("identity", "passwordPolicy"),
    signIn: (i) => m("identity", "signIn", i),
    signOut: () => m("identity", "signOut"),
    register: (i) => m("identity", "register", i),
    verifyEmail: (i) => m("identity", "verifyEmail", i),
    resendVerification: () => m("identity", "resendVerification"),
    requestPasswordReset: (i) => m("identity", "requestPasswordReset", i),
    resetPassword: (i) => m("identity", "resetPassword", i),
    activateAccount: (i) => m("identity", "activateAccount", i),
    changePassword: (i) => m("identity", "changePassword", i),
    assuranceState: () => q("assurance", "getState"),
    beginTotpEnrollment: () => m("assurance", "beginTotpEnrollment"),
    confirmTotpEnrollment: (i) => m("assurance", "confirmTotpEnrollment", i),
    acknowledgeRecoveryCodes: (i) => m("assurance", "acknowledgeRecoveryCodes", i),
    recoverUnacknowledgedCodes: (i) => m("assurance", "recoverUnacknowledgedCodes", i),
    beginPasskeyAuthentication: (i) => m("assurance", "beginPasskeyAuthentication", i),
    challenge: (i) => m("assurance", "challenge", i),
    stepUp: (i) => m("assurance", "stepUp", i),
  };
}

const AuthApiContext = createContext<AuthApi | null>(null);

/** Tests (and storybook-like harnesses) pass `api`; the app passes nothing and the real client is used. */
export function AuthApiProvider({ api, children }: { api?: AuthApi; children: ReactNode }) {
  if (api) return createElement(AuthApiContext.Provider, { value: api }, children);
  return createElement(RealAuthApi, null, children);
}
function RealAuthApi({ children }: { children?: ReactNode }) {
  const client = useTRPCClient();
  const api = useMemo(() => createAuthApi(client), [client]);
  return createElement(AuthApiContext.Provider, { value: api }, children);
}

export function useAuthApi(): AuthApi {
  const api = useContext(AuthApiContext);
  if (!api) throw new Error("AuthApiProvider missing");
  return api;
}

/** Query key for identity.me (shared by guard, shells and session-change handling). */
export const ME_QUERY_KEY = ["rp", "identity", "me"] as const;
