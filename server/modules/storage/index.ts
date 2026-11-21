import { and, asc, count, eq, gt, inArray } from "drizzle-orm";
import type { z } from "zod";
import type { ModuleDeps } from "../../container.js";
import { conflict, DomainError, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import type { AuditEventInput, DbOrTx, SessionPrincipal, Tx } from "../../core/types.js";
import { azureBlobAdapter } from "./adapters/azureBlob.js";
import { s3Adapter } from "./adapters/s3.js";
import { assertCurrentStorageAdmin, assertStorageAdmin } from "./authz.js";
import "./automation.js";
import type {
  StorageAdapter, StorageAdapterDefinition, StorageConfig, StorageConnectionView, StorageCredentials,
  StorageModule, StorageProviderKind, StoragePurpose, StorageTestResult,
} from "./contracts.js";
import { StorageAdapterError } from "./contracts.js";
import { copyLogHealth, createCopyLogService } from "./copyLog.js";
import { registerFileCopies } from "./fileCopies.js";
import { storageAssignments, storageConnections } from "./schema.js";
import { copyMetadata, storageAssignment, storageCreate, storageGet, storageList, storagePublicId, storageTest, storageUpdate } from "./validation.js";

export type { StorageModule } from "./contracts.js";

type Row = typeof storageConnections.$inferSelect;
type Definition = Pick<StorageAdapterDefinition, "purposes"> & {
  parseConfig(value: unknown): StorageConfig;
  parseCredentials(value: unknown): StorageCredentials;
  instantiate(row: Row, credentials: StorageCredentials): StorageAdapter;
};
const knownTestCodes = new Set(["OK", "NOT_CONFIGURED", "AUTH_FAILED", "DESTINATION_NOT_FOUND",
  "DESTINATION_DENIED", "EGRESS_DENIED", "RATE_LIMITED", "PROVIDER_UNAVAILABLE"]);
const aad = (publicId: string) => `storage_connections.credentials_enc:${publicId}`;
const assignmentView = (purpose: StoragePurpose, ids: string[]) =>
  ids.map((connectionPublicId) => ({ purpose, connectionPublicId }));
const view = (row: Row): StorageConnectionView => ({
  publicId: row.publicId, kind: row.kind, name: row.name, config: row.config, enabled: row.enabled,
  credentialsConfigured: !!row.credentialsEnc, oauthConnected: row.oauthConnected, version: row.version,
  lastTest: row.lastTestAt && row.lastTestCode ? {
    ok: row.lastTestCode === "OK", code: row.lastTestCode, checkedAt: row.lastTestAt,
  } : null,
  createdAt: row.createdAt, updatedAt: row.updatedAt,
});
const equalConfig = (a: StorageConfig, b: StorageConfig) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
const oauthKind = (kind: StorageProviderKind) => kind === "dropbox" || kind === "google_drive";

function checked<T>(schema: z.ZodType<T>, value: unknown, code = "STORAGE_INVALID_INPUT"): T {
  const result = schema.safeParse(value);
  if (!result.success) throw validation(code, "Check the storage connection fields and try again.");
  return result.data;
}

function safeTest(result: StorageTestResult): StorageTestResult {
  return knownTestCodes.has(result.code) && result.ok === (result.code === "OK") ? result :
    { ok: false, code: "PROVIDER_UNAVAILABLE" };
}

export function createStorageModule(deps: ModuleDeps): StorageModule {
  const { db, crypto, audit, clock } = deps;
  const providers = new Map<StorageProviderKind, Definition>();

  function provider(kind: StorageProviderKind): Definition {
    const def = providers.get(kind);
    if (!def) throw new DomainError("NOT_CONFIGURED", "STORAGE_ADAPTER_UNAVAILABLE", "This storage provider is not available.");
    return def;
  }

  async function find(publicId: string, handle: DbOrTx, lock = false): Promise<Row> {
    const query = handle.select().from(storageConnections).where(eq(storageConnections.publicId, publicId)).limit(1);
    const [row] = await (lock ? query.for("update") : query);
    if (!row) throw notFound("STORAGE_CONNECTION_NOT_FOUND");
    return row;
  }

  function checkVersion(row: Row, version: number) {
    if (row.version !== version) throw conflict("STORAGE_CONNECTION_CHANGED", "The connection changed. Reload before trying again.");
  }

  function secret(row: Row, def = provider(row.kind)): StorageCredentials | null {
    return row.credentialsEnc ? def.parseCredentials(JSON.parse(crypto.decrypt(row.credentialsEnc, aad(row.publicId)))) : null;
  }

  async function admin<T>(principal: SessionPrincipal, fn: (tx: Tx) => Promise<T>, tx?: Tx): Promise<T> {
    try {
      const execute = async (handle: Tx) => {
        await assertCurrentStorageAdmin(deps, principal, handle);
        return fn(handle);
      };
      return await (tx ? execute(tx) : db.transaction(execute));
    } catch (error) {
      if (!tx && error instanceof DomainError &&
          ["FORBIDDEN", "UNAUTHENTICATED", "REMEDIATION_REQUIRED", "STEP_UP_REQUIRED"].includes(error.code)) {
        await audit.record({
          category: "security", eventName: "storage.admin.denied", action: "access", outcome: "denied",
          actor: { userId: principal.userId, role: principal.role }, reasonCode: error.reasonCode,
        });
      }
      throw error;
    }
  }

  function adminEvent(principal: SessionPrincipal, eventName: string, action: string, publicId?: string): AuditEventInput {
    return { category: "integration", eventName, action, outcome: "completed",
      actor: { userId: principal.userId, role: principal.role },
      resource: publicId ? { type: "storage_connection", publicId } : { type: "storage_assignment" } };
  }

  async function activeRows(purpose: StoragePurpose, handle: DbOrTx): Promise<Row[]> {
    const [assignment] = await handle.select().from(storageAssignments).where(eq(storageAssignments.purpose, purpose));
    if (!assignment?.connectionPublicIds.length) return [];
    const rows = await handle.select().from(storageConnections).where(and(eq(storageConnections.enabled, true),
      inArray(storageConnections.publicId, assignment.connectionPublicIds))).orderBy(asc(storageConnections.publicId));
    return rows.filter((row) => providers.get(row.kind)?.purposes.includes(purpose));
  }

  async function assigned(purpose: StoragePurpose, publicId: string, tx: Tx, generation?: number): Promise<Row> {
    // Lock assignment before connection; assignment updates use the same order.
    const [assignment] = await tx.select().from(storageAssignments).where(eq(storageAssignments.purpose, purpose)).for("update");
    if (!assignment?.connectionPublicIds.includes(publicId)) throw notFound("STORAGE_ASSIGNMENT_INACTIVE");
    const row = await find(publicId, tx, true);
    if (!row.enabled || !providers.get(row.kind)?.purposes.includes(purpose) ||
        (generation !== undefined && row.destinationVersion !== generation)) {
      throw notFound("STORAGE_ASSIGNMENT_INACTIVE");
    }
    return row;
  }

  async function update(principal: SessionPrincipal, raw: Parameters<StorageModule["connections"]["update"]>[1], tx?: Tx) {
    const input = checked(storageUpdate, raw);
    return admin(principal, async (handle) => {
      const row = await find(input.publicId, handle, true);
      checkVersion(row, input.expectedVersion);
      const def = provider(row.kind);
      const config = input.config === undefined ? row.config : def.parseConfig(input.config);
      const configChanged = !equalConfig(config, row.config);
      if (configChanged && (row.oauthConnected || (row.credentialsEnc && input.credentials === undefined))) {
        throw conflict("STORAGE_CREDENTIAL_REPLACEMENT_REQUIRED", "Disconnect OAuth or explicitly replace or clear credentials before changing the destination.");
      }
      if (input.credentials !== undefined && row.oauthConnected && !tx) {
        throw conflict("STORAGE_OAUTH_DISCONNECT_REQUIRED", "Disconnect OAuth before editing its credentials.");
      }
      const replacement = input.credentials ? def.parseCredentials(input.credentials) : input.credentials;
      if (replacement?.refreshToken && (!tx || !oauthKind(row.kind))) {
        throw validation("STORAGE_OAUTH_REQUIRED", "Connect this provider through its consent flow.");
      }
      const changedAuth = configChanged || replacement !== undefined;
      if (input.enabled && (changedAuth || row.lastTestCode !== "OK" || !row.credentialsEnc)) {
        throw conflict("STORAGE_TEST_REQUIRED", "Test this configuration successfully before enabling it.");
      }
      const now = clock.now();
      await handle.update(storageConnections).set({
        name: input.name ?? row.name, config, enabled: changedAuth ? false : input.enabled ?? row.enabled,
        credentialsEnc: replacement === undefined ? row.credentialsEnc :
          replacement === null ? null : crypto.encrypt(JSON.stringify(replacement), aad(row.publicId)),
        oauthConnected: replacement === undefined ? row.oauthConnected : Boolean(replacement?.refreshToken),
        version: row.version + 1,
        destinationVersion: changedAuth ? row.destinationVersion + 1 : row.destinationVersion,
        lastTestAt: changedAuth ? null : row.lastTestAt,
        lastTestCode: changedAuth ? null : row.lastTestCode,
        updatedAt: now,
      }).where(eq(storageConnections.id, row.id));
      await audit.record(adminEvent(principal, changedAuth ? "storage.connection.configuration_changed" : "storage.connection.updated",
        "update", row.publicId), handle);
      return view(await find(row.publicId, handle));
    }, tx);
  }

  const service: StorageModule = {
    copies: createCopyLogService(deps),
    registerAdapter<C extends StorageConfig, S extends StorageCredentials>(
      kind: StorageProviderKind, def: StorageAdapterDefinition<C, S>,
    ) {
      if (providers.has(kind)) throw new Error("Duplicate storage adapter kind");
      providers.set(kind, {
        purposes: [...def.purposes],
        parseConfig: (value) => checked(def.configSchema, value, "STORAGE_CONFIG_INVALID"),
        parseCredentials: (value) => checked(def.credentialsSchema, value, "STORAGE_CREDENTIALS_INVALID"),
        instantiate: (row, credentials) => def.create({
          publicId: row.publicId, config: checked(def.configSchema, row.config, "STORAGE_CONFIG_INVALID"),
          credentials: checked(def.credentialsSchema, credentials, "STORAGE_CREDENTIALS_INVALID"),
        }),
      });
    },
    async health() {
      const [row] = await db.select({ enabled: count() }).from(storageConnections).where(eq(storageConnections.enabled, true));
      const enabled = row?.enabled ?? 0;
      return [{ component: "storage.connections", state: enabled ? "ok" : "disabled", metrics: { enabled },
        summary: enabled ? "Cloud copy destinations are enabled." : "Cloud copy destinations are disabled.", checkedAt: clock.now() },
      await copyLogHealth(deps)];
    },
    connections: {
      async list(principal, raw) {
        const input = checked(storageList, raw);
        return admin(principal, async (tx) => {
          const limit = input.limit ?? 50;
          const rows = await tx.select().from(storageConnections)
            .where(input.cursor ? gt(storageConnections.publicId, input.cursor) : undefined)
            .orderBy(asc(storageConnections.publicId)).limit(limit + 1);
          return { items: rows.slice(0, limit).map(view), nextCursor: rows.length > limit ? rows[limit - 1]!.publicId : null };
        });
      },
      async get(principal, raw) {
        const { publicId } = checked(storageGet, raw);
        return admin(principal, async (tx) => view(await find(publicId, tx)));
      },
      async create(principal, raw) {
        const input = checked(storageCreate, raw);
        return admin(principal, async (tx) => {
          const def = provider(input.kind);
          const publicId = ulid(clock.now().getTime());
          const config = def.parseConfig(input.config);
          const credentials = input.credentials ? def.parseCredentials(input.credentials) : null;
          if (credentials?.refreshToken) throw validation("STORAGE_OAUTH_REQUIRED", "Connect this provider through its consent flow.");
          const now = clock.now();
          await tx.insert(storageConnections).values({ publicId, kind: input.kind, name: input.name, config,
            credentialsEnc: credentials ? crypto.encrypt(JSON.stringify(credentials), aad(publicId)) : null, createdAt: now, updatedAt: now });
          await audit.record(adminEvent(principal, "storage.connection.created", "create", publicId), tx);
          return view(await find(publicId, tx));
        });
      },
      update,
      async test(principal, raw) {
        const input = checked(storageTest, raw);
        assertStorageAdmin(principal, clock.now());
        const limited = await deps.rateLimiter.consume("expensive", `storage-test:${principal.userId}`);
        if (!limited.allowed) throw new DomainError("RATE_LIMITED", "STORAGE_TEST_RATE_LIMITED", "Wait before testing the connection again.");
        const row = await admin(principal, async (tx) => {
          const current = await find(input.publicId, tx, true);
          checkVersion(current, input.expectedVersion);
          await audit.record({ ...adminEvent(principal, "storage.connection.tested", "test", current.publicId), outcome: "attempted" }, tx);
          return current;
        });
        let result: StorageTestResult = { ok: false, code: "NOT_CONFIGURED" };
        try {
          const def = provider(row.kind);
          const credentials = secret(row, def);
          if (credentials) result = safeTest(await def.instantiate(row, credentials).test(AbortSignal.timeout(20_000)));
        } catch {
          result = { ok: false, code: "PROVIDER_UNAVAILABLE" };
        }
        return admin(principal, async (tx) => {
          const current = await find(input.publicId, tx, true);
          checkVersion(current, input.expectedVersion);
          const now = clock.now();
          await tx.update(storageConnections).set({ lastTestAt: now, lastTestCode: result.code,
            updatedAt: now, version: current.version + 1 }).where(eq(storageConnections.id, current.id));
          await audit.record({ ...adminEvent(principal, "storage.connection.tested", "test", current.publicId),
            outcome: result.ok ? "completed" : "failed", reasonCode: result.code }, tx);
          return view(await find(input.publicId, tx));
        });
      },
    },
    assignments: {
      list: (principal) => admin(principal, async (tx) => (await tx.select().from(storageAssignments))
        .flatMap((row) => assignmentView(row.purpose, row.connectionPublicIds))),
      async set(principal, raw) {
        const { purpose, connectionPublicIds } = checked(storageAssignment, raw);
        return admin(principal, async (tx) => {
          const updatedAt = clock.now();
          await tx.insert(storageAssignments).values({ purpose, connectionPublicIds: [], updatedAt })
            .onDuplicateKeyUpdate({ set: { purpose } });
          for (const publicId of [...connectionPublicIds].sort()) {
            const row = await find(publicId, tx, true);
            if (!provider(row.kind).purposes.includes(purpose)) {
              throw validation("STORAGE_PURPOSE_UNSUPPORTED", "This provider does not support the selected purpose.");
            }
          }
          await tx.update(storageAssignments).set({ connectionPublicIds, updatedAt }).where(eq(storageAssignments.purpose, purpose));
          await audit.record({ ...adminEvent(principal, "storage.assignments.changed", "update"),
            safeCounts: { destinations: connectionPublicIds.length } }, tx);
          return assignmentView(purpose, connectionPublicIds);
        });
      },
    },
    async listAssigned(purpose, tx = db) {
      return (await activeRows(purpose, tx)).map(({ publicId, destinationVersion, kind, name }) => ({
        purpose, connectionPublicId: publicId, destinationVersion, kind, name,
      }));
    },
    readProviderSetup: (principal, input, tx) => admin(principal, async (handle) => {
      const row = await find(input.publicId, handle, true);
      if (row.kind !== input.kind) throw notFound("STORAGE_CONNECTION_NOT_FOUND");
      checkVersion(row, input.expectedVersion);
      return { config: row.config, credentials: secret(row) };
    }, tx),
    async readAssignedProvider(input) {
      return db.transaction(async (tx) => {
        await input.assertStillOwned(tx);
        const row = await assigned(input.purpose, input.connectionPublicId, tx);
        if (row.kind !== input.kind) throw notFound("STORAGE_CONNECTION_NOT_FOUND");
        const credentials = secret(row);
        if (!credentials) throw notFound("STORAGE_ASSIGNMENT_INACTIVE");
        return { config: row.config, credentials };
      });
    },
    async copy(input) {
      checked(copyMetadata, input);
      if (input.purpose === "order_data") throw validation("STORAGE_PURPOSE_UNSUPPORTED", "Order data uses the dedicated synchronisation service.");
      const event: AuditEventInput = { category: "integration", eventName: "storage.copy", action: "copy",
        outcome: "attempted", actor: { role: "system" }, resource: { type: "storage_connection", publicId: input.connectionPublicId },
        ...(input.correlationId ? { correlationId: input.correlationId } : {}) };
      const row = await db.transaction(async (tx) => {
        await input.assertStillOwned(tx);
        await input.assertSourceCurrent?.(tx);
        const active = await assigned(input.purpose, input.connectionPublicId, tx, input.expectedDestinationVersion);
        await audit.record(event, tx);
        return active;
      });
      const credentials = secret(row);
      if (!credentials) throw notFound("STORAGE_ASSIGNMENT_INACTIVE");
      const adapter = provider(row.kind).instantiate(row, credentials);
      const check = () => db.transaction(async (tx) => {
        await input.assertStillOwned(tx);
        await input.assertSourceCurrent?.(tx);
        const current = await assigned(input.purpose, input.connectionPublicId, tx, row.destinationVersion);
        if (current.credentialsEnc !== row.credentialsEnc) throw notFound("STORAGE_ASSIGNMENT_INACTIVE");
      });
      let result;
      try {
        const beforeWrite = async () => {
          input.signal?.throwIfAborted();
          await check();
        };
        await beforeWrite();
        await adapter.ensureFolder(input.path, input.signal, beforeWrite);
        await beforeWrite();
        result = await adapter.put({ ...input, beforeWrite });
      } catch (error) {
        if (!(error instanceof StorageAdapterError)) throw error;
        const reason = error.code === "OUTCOME_UNKNOWN" ? "STORAGE_COPY_UNCERTAIN" :
          error.code === "INTEGRITY_MISMATCH" ? "STORAGE_INTEGRITY_MISMATCH" :
          error.code === "EGRESS_DENIED" ? "STORAGE_EGRESS_DENIED" :
          error.retryable ? "STORAGE_PROVIDER_RETRY" : error.code === "TOO_LARGE" ? "STORAGE_PROVIDER_LIMIT" : "STORAGE_PROVIDER_DENIED";
        throw new DomainError(reason === "STORAGE_COPY_UNCERTAIN" ? "UNKNOWN_OUTCOME" : "UNAVAILABLE", reason,
          "The storage provider could not complete the copy.");
      }
      if (!result.remoteId || result.remoteId.length > 4096 || /[\p{C}]/u.test(result.remoteId) ||
          result.size !== input.size || (result.sha256 !== undefined && result.sha256 !== input.sha256)) {
        throw new DomainError("UNAVAILABLE", "STORAGE_INTEGRITY_MISMATCH", "The provider did not verify the uploaded object.");
      }
      await db.transaction(async (tx) => {
        await input.assertStillOwned(tx);
        await audit.record({ ...event, outcome: "completed" }, tx);
      });
      return result;
    },
    async stageOrderFile(filePublicId, tx) {
      await copies.stage(filePublicId, await activeRows("order_files", tx), tx);
    },
    async stageOrderFilesForAutomation(input) {
      const orderPublicId = checked(storagePublicId, input.orderPublicId);
      const filePublicId = input.filePublicId === undefined ? undefined : checked(storagePublicId, input.filePublicId);
      const connectionPublicId = input.connectionPublicId === undefined ? undefined : checked(storagePublicId, input.connectionPublicId);
      if (!/^automation:[A-Za-z0-9_-]{10,40}$/u.test(input.correlationId)) {
        throw validation("STORAGE_AUTOMATION_ORIGIN_INVALID", "This copy must be staged by an automation run.");
      }
      return db.transaction(async (tx) => {
        input.signal.throwIfAborted();
        await input.assertStillOwned(tx);
        const files = await deps.services.files.listOrderFileCopyCandidates(orderPublicId, tx, filePublicId);
        if (files === null) return { queued: 0, cause: "STORAGE_COPY_SOURCE_INACTIVE" };
        if (files.length > 50) return { queued: 0, cause: "STORAGE_COPY_BATCH_LIMIT" };
        const destinations = (await activeRows("order_files", tx)).filter((row) => !connectionPublicId || row.publicId === connectionPublicId);
        if (!destinations.length) return { queued: 0, cause: "STORAGE_ASSIGNMENT_INACTIVE" };
        let queued = 0;
        for (const fileId of files) {
          input.signal.throwIfAborted();
          queued += await copies.stage(fileId, destinations, tx, input.correlationId);
        }
        return { queued };
      }, { isolationLevel: "read committed" });
    },
  };
  const copies = registerFileCopies(deps, service);
  const egress = () => deps.services.integrations.egress;
  service.registerAdapter("s3", s3Adapter(egress, clock));
  service.registerAdapter("azure_blob", azureBlobAdapter(egress, clock));
  return service;
}
