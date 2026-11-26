/**
 * Billing profile domain service (Increment 08, Decision D4).
 * Owner: compliance_engineer.
 *
 * Security & correctness invariants:
 *  - Every tRPC read/write scopes strictly to `principal.userId` (re-verified live in `users` inside the transaction
 *    so suspended/deleted sessions fail closed; no foreign user identifier is accepted over tRPC).
 *  - Ciphertext AAD is bound to `customer_billing_profiles.details:<userPublicId>` so swapping `details_enc` across
 *    rows fails AES-256-GCM authentication.
 *  - Audit events (`billing_profile.saved`, `billing_profile.cleared`, `billing_profile.save_refused`,
 *    `billing_profile.clear_refused`) never carry field values (no name, email, company, address, city, postal code,
 *    country, region, or tax ID).
 *  - `getForUserInTx` / `saveForUserInTx` / `clearForUserInTx` run strictly on the caller's `tx`, never open a second
 *    connection, and never enqueue mail.
 */
import { eq, sql } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { DbOrTx, ModuleHealth, SessionPrincipal, Tx } from "../../core/types.js";
import { users } from "../identity/schema.js";
import { customerBillingProfiles, type CustomerBillingProfileRow } from "./schema.js";
import {
  billingDetailsSchema,
  clearBillingProfileInputSchema,
  saveBillingProfileInputSchema,
  type BillingDetails,
  type BillingDetailsInput,
  type BillingProfileModule,
  type BillingProfileRecord,
  type BillingProfileView,
  type BillingProfileWriteActor,
  type ClearBillingProfileInput,
  type ClearBillingProfileResult,
  type SaveBillingProfileInput,
} from "./types.js";

export function billingProfileDetailsAad(userPublicId: string): string {
  return `customer_billing_profiles.details:${userPublicId}`;
}

export function createBillingProfileService(deps: ModuleDeps): BillingProfileModule {
  const log = deps.logger.child({ module: "billingProfile" });

  function encryptDetails(details: BillingDetails, userPublicId: string): string {
    return deps.crypto.encrypt(JSON.stringify(details), billingProfileDetailsAad(userPublicId));
  }

  function decryptDetails(row: CustomerBillingProfileRow, userPublicId: string): BillingDetails {
    let rawJson: string;
    try {
      rawJson = deps.crypto.decrypt(row.detailsEnc, billingProfileDetailsAad(userPublicId));
    } catch {
      log.error("billing profile ciphertext failed authentication", {
        profilePublicId: row.publicId,
      });
      throw new DomainError(
        "UNAVAILABLE",
        "BILLING_PROFILE_CORRUPT",
        "Saved billing information could not be read. Please re-enter and save your billing information.",
      );
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawJson) as unknown;
    } catch {
      log.error("billing profile plaintext JSON failed parsing", {
        profilePublicId: row.publicId,
      });
      throw new DomainError(
        "UNAVAILABLE",
        "BILLING_PROFILE_CORRUPT",
        "Saved billing information could not be read. Please re-enter and save your billing information.",
      );
    }
    const parsed = billingDetailsSchema.safeParse(parsedJson);
    if (!parsed.success) {
      log.error("billing profile payload failed schema validation", {
        profilePublicId: row.publicId,
      });
      throw new DomainError(
        "UNAVAILABLE",
        "BILLING_PROFILE_CORRUPT",
        "Saved billing information could not be read. Please re-enter and save your billing information.",
      );
    }
    return parsed.data;
  }

  function parseDetailsOrThrow(input: BillingDetailsInput): BillingDetails {
    const parsed = billingDetailsSchema.safeParse(input);
    if (!parsed.success) {
      throw new DomainError(
        "VALIDATION",
        "BILLING_DETAILS_INVALID",
        "Enter complete and valid billing information.",
      );
    }
    return parsed.data;
  }

  async function assertLiveOwnerInTx(
    tx: Tx,
    principal: SessionPrincipal,
    options: { forUpdate?: boolean } = {},
  ): Promise<{ id: number; publicId: string }> {
    const base = tx
      .select({
        id: users.id,
        publicId: users.publicId,
        status: users.status,
      })
      .from(users)
      .where(eq(users.id, principal.userId));

    const [user] = options.forUpdate ? await base.for("update") : await base;
    if (!user || user.publicId !== principal.userPublicId) {
      throw new DomainError("UNAUTHENTICATED", "SESSION_USER_MISSING", "Please sign in again.");
    }
    if (user.status !== "active") {
      throw new DomainError(
        "FORBIDDEN",
        "ACCOUNT_NOT_ACTIVE",
        "Your account is not active and cannot access billing settings.",
      );
    }
    return { id: user.id, publicId: user.publicId };
  }

  async function getForUserInTx(tx: DbOrTx, userId: number): Promise<BillingProfileRecord | null> {
    if (!Number.isSafeInteger(userId) || userId <= 0) return null;
    const [joined] = await tx
      .select({
        profile: customerBillingProfiles,
        userPublicId: users.publicId,
      })
      .from(customerBillingProfiles)
      .innerJoin(users, eq(users.id, customerBillingProfiles.userId))
      .where(eq(customerBillingProfiles.userId, userId));

    if (!joined) return null;
    const details = decryptDetails(joined.profile, joined.userPublicId);
    return {
      publicId: joined.profile.publicId,
      details,
      version: joined.profile.version,
      updatedAt: joined.profile.updatedAt,
    };
  }

  async function saveForUserInTx(
    tx: Tx,
    userId: number,
    detailsInput: BillingDetailsInput,
    actor: BillingProfileWriteActor,
  ): Promise<BillingProfileRecord> {
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new DomainError("VALIDATION", "USER_ID_INVALID", "Account identifier is not valid.");
    }
    const details = parseDetailsOrThrow(detailsInput);

    const [user] = await tx
      .select({ id: users.id, publicId: users.publicId })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");

    if (!user) {
      throw new DomainError("NOT_FOUND", "USER_NOT_FOUND", "Account not found.");
    }

    const [existing] = await tx
      .select()
      .from(customerBillingProfiles)
      .where(eq(customerBillingProfiles.userId, user.id))
      .for("update");

    const now = deps.clock.now();
    const detailsEnc = encryptDetails(details, user.publicId);
    const country = details.country;
    const region = details.region.length > 0 ? details.region : null;
    const via = actor.via ?? "account_settings";

    let rowPublicId: string;
    let nextVersion: number;

    if (!existing) {
      rowPublicId = ulid();
      nextVersion = 1;
      await tx.insert(customerBillingProfiles).values({
        publicId: rowPublicId,
        userId: user.id,
        detailsEnc,
        country,
        region,
        version: nextVersion,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      rowPublicId = existing.publicId;
      nextVersion = existing.version + 1;
      await tx
        .update(customerBillingProfiles)
        .set({
          detailsEnc,
          country,
          region,
          version: nextVersion,
          updatedAt: now,
        })
        .where(eq(customerBillingProfiles.id, existing.id));
    }

    await deps.audit.record(
      {
        category: "business",
        eventName: "billing_profile.saved",
        action: existing ? "update" : "create",
        outcome: "completed",
        actor: {
          userId: actor.userId ?? null,
          role: actor.role,
        },
        resource: { type: "billing_profile", publicId: rowPublicId },
        attributes: {
          version: nextVersion,
          via,
          has_company: details.company.length > 0,
          has_region: details.region.length > 0,
          has_address_line2: details.addressLine2.length > 0,
          has_tax_id: details.taxId.length > 0,
        },
      },
      tx,
    );

    return {
      publicId: rowPublicId,
      details,
      version: nextVersion,
      updatedAt: now,
    };
  }

  async function clearForUserInTx(
    tx: Tx,
    userId: number,
    actor: BillingProfileWriteActor,
  ): Promise<ClearBillingProfileResult> {
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return { cleared: false };
    }
    const [existing] = await tx
      .select()
      .from(customerBillingProfiles)
      .where(eq(customerBillingProfiles.userId, userId))
      .for("update");

    if (!existing) {
      return { cleared: false };
    }

    await tx.delete(customerBillingProfiles).where(eq(customerBillingProfiles.id, existing.id));

    await deps.audit.record(
      {
        category: "business",
        eventName: "billing_profile.cleared",
        action: "delete",
        outcome: "completed",
        actor: {
          userId: actor.userId ?? null,
          role: actor.role,
        },
        resource: { type: "billing_profile", publicId: existing.publicId },
        attributes: {
          previous_version: existing.version,
          via: actor.via ?? "account_settings",
        },
      },
      tx,
    );

    return { cleared: true };
  }

  async function get(principal: SessionPrincipal): Promise<BillingProfileView | null> {
    return deps.db.transaction(async (tx) => {
      const owner = await assertLiveOwnerInTx(tx, principal);
      const [existing] = await tx
        .select()
        .from(customerBillingProfiles)
        .where(eq(customerBillingProfiles.userId, owner.id));
      if (!existing) return null;
      const details = decryptDetails(existing, owner.publicId);
      return {
        publicId: existing.publicId,
        details,
        version: existing.version,
        updatedAt: existing.updatedAt,
      };
    });
  }

  async function save(
    principal: SessionPrincipal,
    rawInput: SaveBillingProfileInput,
  ): Promise<BillingProfileView> {
    const input = saveBillingProfileInputSchema.parse(rawInput);

    const outcome = await deps.db.transaction(async (tx) => {
      const owner = await assertLiveOwnerInTx(tx, principal, { forUpdate: true });
      const [existing] = await tx
        .select()
        .from(customerBillingProfiles)
        .where(eq(customerBillingProfiles.userId, owner.id))
        .for("update");

      const currentVersion = existing?.version ?? 0;
      const generationMatches = !existing
        ? input.expectedPublicId === undefined
        : input.expectedPublicId === existing.publicId;

      if (input.expectedVersion !== currentVersion || !generationMatches) {
        await deps.audit.record(
          {
            category: "business",
            eventName: "billing_profile.save_refused",
            action: existing ? "update" : "create",
            outcome: "refused",
            reasonCode: "BILLING_PROFILE_VERSION_CONFLICT",
            actor: { userId: owner.id, role: principal.role },
            resource: existing
              ? { type: "billing_profile", publicId: existing.publicId }
              : { type: "billing_profile" },
            attributes: {
              expected_version: input.expectedVersion,
              current_version: currentVersion,
              generation_mismatch: !generationMatches,
            },
          },
          tx,
        );
        return {
          kind: "conflict" as const,
          currentVersion,
          currentPublicId: existing?.publicId ?? null,
        };
      }

      const now = deps.clock.now();
      const details = input.details;
      const detailsEnc = encryptDetails(details, owner.publicId);
      const country = details.country;
      const region = details.region.length > 0 ? details.region : null;

      let rowPublicId: string;
      let nextVersion: number;

      if (!existing) {
        rowPublicId = ulid();
        nextVersion = 1;
        await tx.insert(customerBillingProfiles).values({
          publicId: rowPublicId,
          userId: owner.id,
          detailsEnc,
          country,
          region,
          version: nextVersion,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        rowPublicId = existing.publicId;
        nextVersion = existing.version + 1;
        await tx
          .update(customerBillingProfiles)
          .set({
            detailsEnc,
            country,
            region,
            version: nextVersion,
            updatedAt: now,
          })
          .where(eq(customerBillingProfiles.id, existing.id));
      }

      await deps.audit.record(
        {
          category: "business",
          eventName: "billing_profile.saved",
          action: existing ? "update" : "create",
          outcome: "completed",
          actor: { userId: owner.id, role: principal.role },
          resource: { type: "billing_profile", publicId: rowPublicId },
          attributes: {
            version: nextVersion,
            via: "account_settings",
            has_company: details.company.length > 0,
            has_region: details.region.length > 0,
            has_address_line2: details.addressLine2.length > 0,
            has_tax_id: details.taxId.length > 0,
          },
        },
        tx,
      );

      return {
        kind: "saved" as const,
        view: {
          publicId: rowPublicId,
          details,
          version: nextVersion,
          updatedAt: now,
        },
      };
    });

    if (outcome.kind === "conflict") {
      throw new DomainError(
        "CONFLICT",
        "BILLING_PROFILE_VERSION_CONFLICT",
        "Your billing information was updated in another tab or session. Reload and try again.",
        {
          currentVersion: outcome.currentVersion,
          ...(outcome.currentPublicId ? { currentPublicId: outcome.currentPublicId } : {}),
        },
      );
    }

    return outcome.view;
  }

  async function clear(
    principal: SessionPrincipal,
    rawInput: ClearBillingProfileInput,
  ): Promise<ClearBillingProfileResult> {
    const parsed = clearBillingProfileInputSchema.parse(rawInput);

    const outcome = await deps.db.transaction(async (tx) => {
      const owner = await assertLiveOwnerInTx(tx, principal, { forUpdate: true });
      const [existing] = await tx
        .select()
        .from(customerBillingProfiles)
        .where(eq(customerBillingProfiles.userId, owner.id))
        .for("update");

      if (!existing) {
        return { kind: "ok" as const, cleared: false };
      }

      const generationMatches = existing.publicId === parsed.expectedPublicId;
      if (existing.version !== parsed.expectedVersion || !generationMatches) {
        await deps.audit.record(
          {
            category: "business",
            eventName: "billing_profile.clear_refused",
            action: "delete",
            outcome: "refused",
            reasonCode: "BILLING_PROFILE_VERSION_CONFLICT",
            actor: { userId: owner.id, role: principal.role },
            resource: { type: "billing_profile", publicId: existing.publicId },
            attributes: {
              expected_version: parsed.expectedVersion,
              current_version: existing.version,
              generation_mismatch: !generationMatches,
            },
          },
          tx,
        );
        return {
          kind: "conflict" as const,
          currentVersion: existing.version,
          currentPublicId: existing.publicId,
        };
      }

      await tx.delete(customerBillingProfiles).where(eq(customerBillingProfiles.id, existing.id));

      await deps.audit.record(
        {
          category: "business",
          eventName: "billing_profile.cleared",
          action: "delete",
          outcome: "completed",
          actor: { userId: owner.id, role: principal.role },
          resource: { type: "billing_profile", publicId: existing.publicId },
          attributes: {
            previous_version: existing.version,
            via: "account_settings",
          },
        },
        tx,
      );

      return { kind: "ok" as const, cleared: true };
    });

    if (outcome.kind === "conflict") {
      throw new DomainError(
        "CONFLICT",
        "BILLING_PROFILE_VERSION_CONFLICT",
        "Your billing information was updated in another tab or session. Reload and try again.",
        {
          currentVersion: outcome.currentVersion,
          ...(outcome.currentPublicId ? { currentPublicId: outcome.currentPublicId } : {}),
        },
      );
    }

    return { cleared: outcome.cleared };
  }

  async function health(): Promise<ModuleHealth[]> {
    const started = Date.now();
    try {
      const [row] = await deps.db
        .select({ count: sql<number>`count(*)` })
        .from(customerBillingProfiles);
      return [
        {
          component: "billingProfile.store",
          state: "ok",
          summary: "Billing profile store reachable",
          metrics: {
            profiles: Number(row?.count ?? 0),
            latencyMs: Date.now() - started,
          },
          checkedAt: deps.clock.now(),
        },
      ];
    } catch {
      return [
        {
          component: "billingProfile.store",
          state: "failing",
          summary: "Billing profile store unreachable",
          metrics: {
            latencyMs: Date.now() - started,
          },
          checkedAt: deps.clock.now(),
        },
      ];
    }
  }

  return {
    get,
    save,
    clear,
    getForUserInTx,
    saveForUserInTx,
    clearForUserInTx,
    health,
  };
}
