/**
 * Durable, truthful provider check state repository (`integration_provider_checks`).
 *
 * Ensures no optional provider is ever reported as `"ok"` in `ModuleLifecycle.health()` unless a real
 * verification check has succeeded.
 */
import { eq } from "drizzle-orm";
import type { ModuleDeps } from "../../container.js";
import type { DbOrTx } from "../../core/types.js";
import { integrationProviderChecks } from "./schema.js";

export type CheckOutcome = "succeeded" | "failed" | "unknown";

export interface ProviderCheckRecord {
  providerKey: string;
  lastCheckedAt: Date;
  lastOutcome: CheckOutcome;
  lastReasonCode: string | null;
  verifiedAt: Date | null;
  consecutiveFailures: number;
}

function isMissingTestSubsetTable(error: unknown, isTestEnv: boolean): boolean {
  if (!isTestEnv) return false;
  const msg = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;
  return (
    code === "ER_NO_SUCH_TABLE" ||
    msg.includes("no db supplied") ||
    msg.includes("doesn't exist")
  );
}

export interface ProviderChecksStore {
  get(providerKey: string): Promise<ProviderCheckRecord | null>;
  getAll(): Promise<Map<string, ProviderCheckRecord>>;
  recordOutcome(
    providerKey: string,
    outcome: CheckOutcome,
    reasonCode?: string | null,
    tx?: DbOrTx,
  ): Promise<ProviderCheckRecord>;
  clearVerification(providerKey: string, tx?: DbOrTx): Promise<void>;
}

export function createProviderChecksStore(deps: Pick<ModuleDeps, "db" | "clock" | "config">): ProviderChecksStore {
  const isTestEnv = deps.config.nodeEnv === "test";

  function toRecord(row: typeof integrationProviderChecks.$inferSelect): ProviderCheckRecord {
    const outcome: CheckOutcome =
      row.lastOutcome === "succeeded" || row.lastOutcome === "failed" ? row.lastOutcome : "unknown";
    return {
      providerKey: row.providerKey,
      lastCheckedAt: row.lastCheckedAt,
      lastOutcome: outcome,
      lastReasonCode: row.lastReasonCode ?? null,
      verifiedAt: row.verifiedAt ?? null,
      consecutiveFailures: row.consecutiveFailures,
    };
  }

  return {
    async get(providerKey: string): Promise<ProviderCheckRecord | null> {
      try {
        const [row] = await deps.db
          .select()
          .from(integrationProviderChecks)
          .where(eq(integrationProviderChecks.providerKey, providerKey))
          .limit(1);
        return row ? toRecord(row) : null;
      } catch (error) {
        if (isMissingTestSubsetTable(error, isTestEnv)) return null;
        throw error;
      }
    },

    async getAll(): Promise<Map<string, ProviderCheckRecord>> {
      const map = new Map<string, ProviderCheckRecord>();
      try {
        const rows = await deps.db.select().from(integrationProviderChecks).limit(32);
        for (const row of rows) {
          map.set(row.providerKey, toRecord(row));
        }
        return map;
      } catch (error) {
        if (isMissingTestSubsetTable(error, isTestEnv)) return map;
        throw error;
      }
    },

    async recordOutcome(
      providerKey: string,
      outcome: CheckOutcome,
      reasonCode: string | null = null,
      tx?: DbOrTx,
    ): Promise<ProviderCheckRecord> {
      const handle = tx ?? deps.db;
      const now = deps.clock.now();
      const [existing] = await handle
        .select()
        .from(integrationProviderChecks)
        .where(eq(integrationProviderChecks.providerKey, providerKey))
        .limit(1);

      const verifiedAt = outcome === "succeeded" ? now : (existing?.verifiedAt ?? null);
      const consecutiveFailures =
        outcome === "succeeded" ? 0 : (existing?.consecutiveFailures ?? 0) + 1;

      if (existing) {
        await handle
          .update(integrationProviderChecks)
          .set({
            lastCheckedAt: now,
            lastOutcome: outcome,
            lastReasonCode: reasonCode,
            verifiedAt,
            consecutiveFailures,
            updatedAt: now,
          })
          .where(eq(integrationProviderChecks.id, existing.id));
      } else {
        await handle.insert(integrationProviderChecks).values({
          providerKey,
          lastCheckedAt: now,
          lastOutcome: outcome,
          lastReasonCode: reasonCode,
          verifiedAt,
          consecutiveFailures,
          createdAt: now,
          updatedAt: now,
        });
      }

      return {
        providerKey,
        lastCheckedAt: now,
        lastOutcome: outcome,
        lastReasonCode: reasonCode,
        verifiedAt,
        consecutiveFailures,
      };
    },

    async clearVerification(providerKey: string, tx?: DbOrTx): Promise<void> {
      const handle = tx ?? deps.db;
      try {
        await handle
          .delete(integrationProviderChecks)
          .where(eq(integrationProviderChecks.providerKey, providerKey));
      } catch (error) {
        if (isMissingTestSubsetTable(error, isTestEnv)) return;
        throw error;
      }
    },
  };
}
