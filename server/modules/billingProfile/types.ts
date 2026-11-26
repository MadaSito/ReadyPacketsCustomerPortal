/**
 * Billing profile types, input schemas, and cross-module port contracts (Increment 08, Decision D4).
 * Owner: compliance_engineer.
 */
import { z } from "zod";
import {
  billingDetailsSchema,
  type BillingDetails,
  type BillingDetailsInput,
} from "../../../shared/billingDetails.js";
import type { UserRole } from "../../../shared/domain.js";
import type { DbOrTx, ModuleLifecycle, SessionPrincipal, Tx } from "../../core/types.js";

export { billingDetailsSchema, type BillingDetails, type BillingDetailsInput };

export const BILLING_PROFILE_WRITE_SOURCES = [
  "account_settings",
  "registration",
  "checkout",
  "portable_import",
  "account_erasure",
] as const;

export type BillingProfileWriteSource = (typeof BILLING_PROFILE_WRITE_SOURCES)[number];

export interface BillingProfileWriteActor {
  userId?: number | null;
  role: UserRole | "system" | "anonymous";
  via?: BillingProfileWriteSource;
}

export interface BillingProfileView {
  publicId: string;
  details: BillingDetails;
  version: number;
  updatedAt: Date;
}

export type BillingProfileRecord = BillingProfileView;

export const saveBillingProfileInputSchema = z
  .object({
    details: billingDetailsSchema,
    /**
     * Optimistic concurrency version token:
     *  - `0` (default when omitted) asserts no saved billing profile existed when loaded.
     *  - `>= 1` asserts the current saved row has `version === expectedVersion` AND `publicId === expectedPublicId`.
     */
    expectedVersion: z.number().int().min(0).optional().default(0),
    /**
     * Generation token (`customer_billing_profiles.public_id`). Required when `expectedVersion >= 1`
     * so hard-delete + recreation at `version = 1` cannot be overwritten by a stale tab (ABA protection).
     */
    expectedPublicId: z.string().trim().min(1).max(36).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const version = val.expectedVersion ?? 0;
    if (version >= 1 && !val.expectedPublicId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedPublicId"],
        message: "expectedPublicId is required when expectedVersion is 1 or greater.",
      });
    }
    if (version === 0 && val.expectedPublicId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedPublicId"],
        message: "expectedPublicId must be omitted when expectedVersion is 0.",
      });
    }
  });

export type SaveBillingProfileInput = z.input<typeof saveBillingProfileInputSchema>;

export const clearBillingProfileInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    expectedPublicId: z.string().trim().min(1).max(36),
  })
  .strict();

export type ClearBillingProfileInput = z.input<typeof clearBillingProfileInputSchema>;

export interface ClearBillingProfileResult {
  cleared: boolean;
}

export interface GetBillingProfileInTxOptions {
  /**
   * Perform a current locking read (`FOR UPDATE`) on `customer_billing_profiles` under a caller-held
   * `users FOR UPDATE` lock so InnoDB `REPEATABLE READ` does not return an earlier pre-lock snapshot.
   */
  forUpdate?: boolean;
  /**
   * Perform a shared current locking read (`FOR SHARE`) on `customer_billing_profiles` under a caller-held
   * `users` lock so InnoDB `REPEATABLE READ` does not return an earlier pre-lock snapshot.
   */
  forShare?: boolean;
}

export interface BillingProfileModule extends ModuleLifecycle {
  /** Owner-scoped read for the signed-in account. Returns `null` when no billing profile is saved. */
  get(principal: SessionPrincipal): Promise<BillingProfileView | null>;

  /** Owner-scoped save with optimistic concurrency (`expectedVersion` + `expectedPublicId`). */
  save(principal: SessionPrincipal, input: SaveBillingProfileInput): Promise<BillingProfileView>;

  /** Owner-scoped clear (idempotent when already absent; enforces `expectedVersion` + `expectedPublicId` when present). */
  clear(principal: SessionPrincipal, input: ClearBillingProfileInput): Promise<ClearBillingProfileResult>;

  /**
   * Cross-module transactional read port (cart checkout, portable export).
   * Uses `tx` strictly — never opens a nested transaction or second pool connection.
   */
  getForUserInTx(
    tx: DbOrTx,
    userId: number,
    options?: GetBillingProfileInTxOptions,
  ): Promise<BillingProfileRecord | null>;

  /**
   * Cross-module transactional upsert port (registration on new account creation, checkout "Save as my billing
   * information", portable import).
   * Guarantees:
   *  1. Executes strictly on the caller's `tx` (never opens its own transaction or touches a second connection).
   *  2. Never enqueues mail; emits a durable `billing_profile.saved` audit event strictly on `tx` with zero PII.
   */
  saveForUserInTx(
    tx: Tx,
    userId: number,
    details: BillingDetailsInput,
    actor: BillingProfileWriteActor,
  ): Promise<BillingProfileRecord>;

  /**
   * Cross-module transactional clear port (account erasure / cleanup).
   * Executes strictly on `tx` and emits `billing_profile.cleared` on `tx` when a row existed.
   */
  clearForUserInTx(
    tx: Tx,
    userId: number,
    actor: BillingProfileWriteActor,
  ): Promise<ClearBillingProfileResult>;
}
