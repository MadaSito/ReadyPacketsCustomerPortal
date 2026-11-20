/**
 * End-to-end backup, verification, isolated restore, security-state continuity, tamper detection,
 * retention + legal holds, and cross-model transaction safety tests against real MySQL + mysqldump/mysql
 * + LocalObjectStorage. SYNTHETIC DATA ONLY (`*.example.test`).
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { eq } from "drizzle-orm";
import express from "express";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModuleDeps, Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { newRequestContext } from "../../core/requestContext.js";
import type { SessionPrincipal, Tx } from "../../core/types.js";
import { createDatabase } from "../../db/client.js";
import { setHttpState } from "../../http/requestState.js";
import { rateLimitCounters } from "../../security/rateLimiterSchema.js";
import { router } from "../../trpc/trpc.js";
import { createTestDb, type TestDb } from "../../../tests/helpers/testDb.js";
import { createTestDeps, fakePrincipal } from "../../../tests/helpers/fakes.js";
import {
  assuranceAccounts,
  assuranceChallenges,
  assurancePasskeys,
  assuranceRecoveryCodes,
} from "../assurance/schema.js";
import { createChainService } from "../audit/chain.js";
import { createAuditEmitter } from "../audit/emitter.js";
import {
  auditChain,
  auditChainHead,
  auditCheckpoints,
  auditEvents,
  auditTombstones,
} from "../audit/schema.js";
import { fileDownloadTickets, orderFiles } from "../files/schema.js";
import { createObjectStorage } from "../files/storage.js";
import { identityTokens, userSessions, users } from "../identity/schema.js";
import { jobRuns, mailOutbox } from "../jobs/schema.js";
import { platformPresentationImages, platformSettings } from "../platform/schema.js";
import { createSettingsStore } from "../platform/settingsStore.js";
import { registerBackupHttpRoutes } from "./http.js";
import {
  createBackupModule,
  expectedRestoreConfirmationText,
} from "./index.js";
import { backupRouter } from "./router.js";
import {
  backupArchives,
  backupLegalHolds,
  backupRestoreDrills,
  backupVerifications,
} from "./schema.js";
// Side-effect import ensures backup setting definitions are registered in the platform settings registry.
import "./settings.js";

const TEST_SCHEMA = {
  users,
  userSessions,
  identityTokens,
  assuranceAccounts,
  assuranceRecoveryCodes,
  assurancePasskeys,
  assuranceChallenges,
  rateLimitCounters,
  jobRuns,
  mailOutbox,
  platformSettings,
  platformPresentationImages,
  orderFiles,
  fileDownloadTickets,
  auditEvents,
  auditChain,
  auditChainHead,
  auditCheckpoints,
  auditTombstones,
  backupArchives,
  backupVerifications,
  backupRestoreDrills,
  backupLegalHolds,
};

const baseMysqlUrl = () => process.env.RP_DEV_MYSQL_URL ?? "mysql://rp_dev:rp_dev_local_only@127.0.0.1:3306";

describe("backup module — encrypted backup, verify, isolated restore, continuity & retention", () => {
  let tdb: TestDb;
  let tempRoot: string;
  let liveStorageDir: string;
  let sandboxRootDir: string;
  let keyFilePath: string;
  let rawKeyBase64: string;
  const createdRestoreDbs: string[] = [];

  let adminUserId = 0;
  let adminPublicId = "";
  let customerUserId = 0;
  let customerPublicId = "";

  // Mutable live actor session state so tests can exercise in-transaction session revocation / role downgrade!
  const actorDirectory = new Map<
    string,
    {
      role: SessionPrincipal["role"];
      pendingSteps: SessionPrincipal["pendingSteps"];
      stepUpAt: Date | null;
      revoked: boolean;
    }
  >();

  function buildIdentityStub() {
    return {
      sessions: {
        async assertCurrent(principal: SessionPrincipal, tx: Tx) {
          // Lock the actor row inside `tx` on the SAME connection to mirror IdentityModule.sessions.assertCurrent
          const [uRow] = await tx
            .select({ id: users.id, role: users.role, status: users.status })
            .from(users)
            .where(eq(users.id, principal.userId))
            .limit(1)
            .for("update");
          if (!uRow || uRow.status !== "active") {
            throw new DomainError("UNAUTHENTICATED", "ACTOR_INACTIVE", "Account is not active.");
          }
          const state = actorDirectory.get(principal.sessionId);
          if (!state || state.revoked) {
            throw new DomainError("UNAUTHENTICATED", "SESSION_REVOKED", "Session has been revoked.");
          }
          return {
            pendingSteps: state.pendingSteps,
            role: state.role,
            stepUpAt: state.stepUpAt,
            mfaVerifiedAt: state.stepUpAt,
          };
        },
      },
    };
  }

  function makeAdminPrincipal(overrides: Partial<SessionPrincipal> = {}): SessionPrincipal {
    const now = new Date("2026-04-01T12:00:00.000Z");
    const sessionId = overrides.sessionId ?? `sess_admin_${randomBytes(4).toString("hex")}`;
    const role = overrides.role ?? "admin";
    const pendingSteps = overrides.pendingSteps ?? [];
    const stepUpAt = overrides.stepUpAt !== undefined ? overrides.stepUpAt : now;
    actorDirectory.set(sessionId, {
      role,
      pendingSteps,
      stepUpAt,
      revoked: false,
    });
    return fakePrincipal({
      sessionId,
      userId: adminUserId,
      userPublicId: adminPublicId,
      role,
      state: overrides.state ?? "full",
      pendingSteps,
      stepUpAt,
      mfaVerifiedAt: stepUpAt,
      ...overrides,
    });
  }

  beforeAll(async () => {
    tdb = await createTestDb({ schema: TEST_SCHEMA });
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "rp-backup-suite-"));
    await chmod(tempRoot, 0o700);

    liveStorageDir = path.join(tempRoot, "live-storage");
    sandboxRootDir = path.join(tempRoot, "recovery-sandbox");
    keyFilePath = path.join(tempRoot, "backup.key");

    rawKeyBase64 = randomBytes(32).toString("base64");
    await writeFile(keyFilePath, `${rawKeyBase64}\n`, { mode: 0o600 });
    await chmod(keyFilePath, 0o600);

    const h = createTestDeps({ db: tdb.db });
    const now = new Date("2026-04-01T11:00:00.000Z");

    adminPublicId = ulid(now.getTime());
    const [adminIns] = await tdb.db.insert(users).values({
      publicId: adminPublicId,
      emailEnc: h.deps.crypto.encrypt("admin@portal.example.test", `users.email:${adminPublicId}`),
      emailIndex: h.deps.crypto.blindIndex("admin@portal.example.test", "users.email"),
      nameEnc: h.deps.crypto.encrypt("Synthetic Admin", `users.name:${adminPublicId}`),
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$synthetic$synthetichash",
      mustChangePassword: false,
      role: "admin",
      status: "active",
      emailVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    adminUserId = Number(adminIns.insertId);

    customerPublicId = ulid(now.getTime() + 1);
    const [custIns] = await tdb.db.insert(users).values({
      publicId: customerPublicId,
      customerRef: "CUST-TEST-001",
      emailEnc: h.deps.crypto.encrypt("alice@customer.example.test", `users.email:${customerPublicId}`),
      emailIndex: h.deps.crypto.blindIndex("alice@customer.example.test", "users.email"),
      nameEnc: h.deps.crypto.encrypt("Alice Customer", `users.name:${customerPublicId}`),
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$synthetic$synthetichash_cust",
      mustChangePassword: false,
      role: "customer",
      status: "active",
      emailVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    customerUserId = Number(custIns.insertId);
  }, 60_000);

  afterAll(async () => {
    const admin = await mysql.createConnection({ uri: baseMysqlUrl() });
    for (const dbName of createdRestoreDbs) {
      if (/^rp_test_restore_[a-z0-9_]+$/.test(dbName)) {
        await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      }
    }
    await admin.end();
    if (tdb) await tdb.cleanup();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  function buildRealStorageHarness(customEnv: NodeJS.ProcessEnv, customDb = tdb.db) {
    const harness = createTestDeps({
      db: customDb,
      config: { storageDir: liveStorageDir, databaseUrl: tdb.url },
      now: new Date("2026-04-01T12:00:00.000Z"),
    });
    const realStorage = createObjectStorage({
      config: { storageDir: liveStorageDir },
      logger: harness.deps.logger,
    });
    const deps: ModuleDeps = {
      ...harness.deps,
      storage: realStorage,
    };
    (deps.services as unknown as Record<string, unknown>).identity = buildIdentityStub();
    const mod = createBackupModule(deps, {
      env: customEnv,
      databaseUrlOverride: tdb.url,
    });
    (deps.services as unknown as Record<string, unknown>).backup = mod;
    return { harness, deps, mod, realStorage };
  }

  it("refuses backup fail-closed when encryption key is missing, weak, or stored in a world-readable file", async () => {
    // 1. Missing key -> refuses both enqueueBackup and runBackupDirect with BACKUP_KEY_MISSING
    const missing = buildRealStorageHarness({});
    const healthMissing = await missing.mod.health!();
    expect(healthMissing.find((h) => h.component === "backup.status")?.state).toBe("not_configured");
    expect(healthMissing.find((h) => h.component === "backup.offhost")?.state).toBe("not_configured");

    const admin = makeAdminPrincipal();
    await expect(missing.mod.enqueueBackup(admin)).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
      reasonCode: "BACKUP_KEY_MISSING",
    });
    await expect(missing.mod.runBackupDirect({ actorUserId: adminUserId })).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
      reasonCode: "BACKUP_KEY_MISSING",
    });
    expect(missing.harness.audit.events.some((e) => e.eventName === "backup.archive.refused")).toBe(true);

    // 2. Weak inline passphrase (< 16 chars) -> refuses with BACKUP_KEY_WEAK
    const weak = buildRealStorageHarness({ RP_BACKUP_KEY: "short-key" });
    const healthWeak = await weak.mod.health!();
    expect(healthWeak.find((h) => h.component === "backup.status")?.state).toBe("failing");
    await expect(weak.mod.runBackupDirect({ actorUserId: adminUserId })).rejects.toMatchObject({
      reasonCode: "BACKUP_KEY_WEAK",
    });

    // 3. World-readable key file (0644) -> refuses with BACKUP_KEY_UNSAFE_FILE
    const unsafeFile = path.join(tempRoot, "unsafe-world-readable.key");
    await writeFile(unsafeFile, `${rawKeyBase64}\n`, { mode: 0o644 });
    await chmod(unsafeFile, 0o644);
    const unsafe = buildRealStorageHarness({ RP_BACKUP_KEY_FILE: unsafeFile });
    await expect(unsafe.mod.runBackupDirect({ actorUserId: adminUserId })).rejects.toMatchObject({
      reasonCode: "BACKUP_KEY_UNSAFE_FILE",
    });
  });

  it("completes real mysqldump + object backup, byte-level verify, isolated restore, and §7.3 security-state continuity", async () => {
    const now = new Date("2026-04-01T12:00:00.000Z");
    const env: NodeJS.ProcessEnv = {
      RP_BACKUP_KEY_FILE: keyFilePath,
      RP_BACKUP_KEY_ID: "bk-primary-2026",
      RP_RECOVERY_SANDBOX_DIR: sandboxRootDir,
    };
    const { harness, deps, realStorage } = buildRealStorageHarness(env);

    // Wire real durable audit emitter + hash chain so restored audit chain verification is genuinely exercised!
    const realEmitter = createAuditEmitter({
      config: deps.config,
      db: tdb.db,
      clock: deps.clock,
      logger: deps.logger,
      crypto: deps.crypto,
    });
    const realDeps: ModuleDeps = {
      ...deps,
      audit: realEmitter,
    };
    const realMod = createBackupModule(realDeps, { env, databaseUrlOverride: tdb.url });
    (realDeps.services as unknown as Record<string, unknown>).backup = realMod;

    // Seed synthetic private objects in LocalObjectStorage + DB rows
    const secretCanaryPayload = Buffer.from("CONFIDENTIAL_PACKET_CONTENT_CANARY_9918273645", "utf8");
    const fileStorageKey = realStorage.newKey("files");
    const storedFile = await realStorage.put(fileStorageKey, Readable.from([secretCanaryPayload]));
    const filePublicId = ulid(now.getTime() + 10);
    await tdb.db.insert(orderFiles).values({
      publicId: filePublicId,
      logicalPublicId: filePublicId,
      orderId: 101,
      orderPublicId: ulid(now.getTime() + 9),
      ownerUserId: customerUserId,
      uploadedByUserId: adminUserId,
      storageKey: fileStorageKey,
      displayNameEnc: deps.crypto.encrypt("packet-summary.pdf", `order_files.name:${filePublicId}`),
      category: "deliverable",
      visibility: "customer_visible",
      byteSize: storedFile.size,
      sha256: storedFile.sha256,
      contentType: "application/pdf",
      extension: "pdf",
      createdAt: now,
    });

    const slidePayload = Buffer.from("PRESENTATION_SLIDE_BYTES_SYNTHETIC_88271", "utf8");
    const slideStorageKey = realStorage.newKey("files");
    const storedSlide = await realStorage.put(slideStorageKey, Readable.from([slidePayload]));
    await tdb.db.insert(platformPresentationImages).values({
      publicId: ulid(now.getTime() + 11),
      storageKey: slideStorageKey,
      mimeType: "image/webp",
      byteSize: storedSlide.size,
      sha256: storedSlide.sha256,
      width: 1200,
      height: 800,
      uploadedByUserId: adminUserId,
      createdAt: now,
    });

    // Seed security-sensitive tables before backup
    const liveSessPublicId = ulid(now.getTime() + 20);
    await tdb.db.insert(userSessions).values({
      publicId: liveSessPublicId,
      userId: customerUserId,
      tokenHash: randomBytes(32).toString("hex"),
      csrfSecretEnc: deps.crypto.encrypt("csrf_secret_test", `user_sessions.csrf:${liveSessPublicId}`),
      authMethod: "local",
      authenticatedAt: now,
      mfaVerifiedAt: now,
      stepUpAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: new Date(now.getTime() + 86_400_000),
      createdAt: now,
    });

    await tdb.db.insert(identityTokens).values({
      userId: customerUserId,
      purpose: "password_reset",
      tokenHash: randomBytes(32).toString("hex"),
      expiresAt: new Date(now.getTime() + 3_600_000),
      createdAt: now,
    });

    const assurancePublicId = ulid(now.getTime() + 22);
    const recoverySetId = ulid(now.getTime() + 23);
    await tdb.db.insert(assuranceAccounts).values({
      publicId: assurancePublicId,
      userId: customerUserId,
      totpSecretEnc: deps.crypto.encrypt("JBSWY3DPEHPK3PXP", `assurance.totp:${assurancePublicId}`),
      lastTotpStep: 100,
      recoverySetId,
      recoveryAcknowledgedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const recCodeHash1 = randomBytes(32).toString("hex");
    const recCodeHash2 = randomBytes(32).toString("hex");
    await tdb.db.insert(assuranceRecoveryCodes).values([
      {
        publicId: ulid(now.getTime() + 24),
        userId: customerUserId,
        codeHash: recCodeHash1,
        usedAt: null,
        createdAt: now,
      },
      {
        publicId: ulid(now.getTime() + 25),
        userId: customerUserId,
        codeHash: recCodeHash2,
        usedAt: null,
        createdAt: now,
      },
    ]);

    const passkeyPublicId = ulid(now.getTime() + 26);
    const credentialIndex = randomBytes(32).toString("hex");
    await tdb.db.insert(assurancePasskeys).values({
      publicId: passkeyPublicId,
      userId: customerUserId,
      credentialId: "c3ludGhldGljLWNyZWRlbnRpYWwtaWQ",
      credentialIndex,
      publicKey: "c3ludGhldGljLWNvc2Uta2V5",
      counter: 5,
      nameEnc: deps.crypto.encrypt("Security Key", `assurance.passkey:${passkeyPublicId}`),
      createdAt: now,
      updatedAt: now,
    });

    await tdb.db.insert(assuranceChallenges).values({
      publicId: ulid(now.getTime() + 27),
      userId: customerUserId,
      sessionId: liveSessPublicId,
      purpose: "challenge",
      challengeHash: randomBytes(32).toString("hex"),
      expiresAt: new Date(now.getTime() + 300_000),
      createdAt: now,
    });

    await tdb.db.insert(fileDownloadTickets).values({
      tokenHash: randomBytes(32).toString("hex"),
      orderId: 101,
      fileId: 1,
      userId: customerUserId,
      sessionId: liveSessPublicId,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });

    await tdb.db.insert(rateLimitCounters).values({
      category: "user_login",
      slot: 42,
      hits: 2,
      resetAt: new Date(now.getTime() + 3_600_000),
    });

    await tdb.db.insert(jobRuns).values({
      publicId: ulid(now.getTime() + 30),
      type: "engagement.digest",
      state: "queued",
      correlationId: ulid(now.getTime() + 30),
      maxAttempts: 3,
      runAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await tdb.db.insert(mailOutbox).values({
      publicId: ulid(now.getTime() + 31),
      template: "orders.status_changed",
      idempotencyHash: randomBytes(32).toString("hex"),
      correlationId: ulid(now.getTime() + 31),
      state: "queued",
      expiresAt: new Date(now.getTime() + 86_400_000),
      createdAt: now,
      updatedAt: now,
    });

    await tdb.db.insert(platformSettings).values({
      settingKey: "flag:siem.forwarding.enabled",
      kind: "flag",
      valueJson: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    // Record and seal genuine audit events BEFORE taking the backup!
    await realEmitter.record({
      category: "security",
      eventName: "auth.session.created",
      action: "login",
      outcome: "completed",
      severity: "INFO",
      actor: { userId: customerUserId, role: "customer" },
    });
    const chainSvc = createChainService({
      db: tdb.db,
      clock: deps.clock,
      logger: deps.logger,
      auditChainKey: deps.config.auditChainKey,
      installationId: deps.config.installationId,
    });
    harness.clock.advance(16 * 60 * 1000);
    const sealedRes = await chainSvc.sealPending({ fullScan: true });
    expect(sealedRes.sealed).toBeGreaterThanOrEqual(1);

    // 1. Run encrypted backup
    const archiveSummary = await realMod.runBackupDirect({
      trigger: "manual",
      actorUserId: adminUserId,
    });
    expect(archiveSummary.state).toBe("completed");
    expect(archiveSummary.backupKeyId).toBe("bk-primary-2026");
    expect(archiveSummary.keyCustodyMode).toBe("host_file");
    expect(archiveSummary.objectCount).toBe(2);
    expect(archiveSummary.offHostCopyStatus).toBe("local_only");
    expect(archiveSummary.encryptedSizeBytes).toBeGreaterThan(200);

    // Inspect raw `.rpbk` file on disk: must start with RPBK0001 and contain ZERO plaintext SQL or file canaries!
    const [dbArchiveRow] = await tdb.db
      .select()
      .from(backupArchives)
      .where(eq(backupArchives.publicId, archiveSummary.publicId));
    expect(dbArchiveRow?.storageKey).toMatch(/^backups\/[0-9a-f]{32}$/);
    const rawEncryptedFile = await readFile(path.join(liveStorageDir, dbArchiveRow!.storageKey!));
    expect(rawEncryptedFile.subarray(0, 8).toString("ascii")).toBe("RPBK0001");
    expect(rawEncryptedFile.includes(secretCanaryPayload)).toBe(false);
    expect(rawEncryptedFile.includes(Buffer.from("CUST-TEST-001", "utf8"))).toBe(false);
    expect(rawEncryptedFile.includes(Buffer.from("CREATE TABLE", "utf8"))).toBe(false);

    // Before verify, health is degraded ("no verified encrypted backup exists yet")
    const preVerifyHealth = await realMod.health!();
    expect(preVerifyHealth.find((h) => h.component === "backup.status")?.state).toBe("degraded");

    // 2. Byte-level verify
    const admin = makeAdminPrincipal({ stepUpAt: deps.clock.now() });
    const verified = await realMod.verifyBackup(admin, archiveSummary.publicId);
    expect(verified.state).toBe("completed");
    expect(verified.authenticatedBytes).toBeGreaterThan(100);
    expect(verified.sqlSha256Matched).toBe(true);
    expect(verified.objectsVerified).toBe(2);
    expect(verified.manifestValid).toBe(true);
    expect(verified.keyReadiness).toBe("ready");

    // After verify, health is ok!
    const postVerifyHealth = await realMod.health!();
    expect(postVerifyHealth.find((h) => h.component === "backup.status")?.state).toBe("ok");

    // 3. Simulate post-backup anti-replay security events on the LIVE database BEFORE restoring:
    // - TOTP step advances well beyond floor(now / 30s) so we prove live watermark propagation too!
    const highTotpStep = Math.floor(deps.clock.now().getTime() / 30_000) + 500;
    const postBackupNow = deps.clock.now();
    await tdb.db
      .update(assuranceAccounts)
      .set({ lastTotpStep: highTotpStep, updatedAt: postBackupNow })
      .where(eq(assuranceAccounts.userId, customerUserId));
    await tdb.db
      .update(assurancePasskeys)
      .set({ counter: 19, updatedAt: postBackupNow })
      .where(eq(assurancePasskeys.userId, customerUserId));
    await tdb.db
      .update(assuranceRecoveryCodes)
      .set({ usedAt: postBackupNow })
      .where(eq(assuranceRecoveryCodes.codeHash, recCodeHash1));
    await tdb.db
      .update(rateLimitCounters)
      .set({ hits: 9 })
      .where(eq(rateLimitCounters.slot, 42));

    // 4. Restore into an ISOLATED target database (`rp_test_restore_*`) and isolated sandbox storage subdir
    const isolatedDbName = `rp_test_restore_${randomBytes(4).toString("hex")}`;
    createdRestoreDbs.push(isolatedDbName);

    const drill = await realMod.restoreToIsolatedTarget(admin, {
      backupPublicId: archiveSummary.publicId,
      targetDatabaseName: isolatedDbName,
      targetStoragePath: "drill-alpha",
      continuityMode: "preserve_continuity",
      confirmationText: expectedRestoreConfirmationText(archiveSummary.publicId, isolatedDbName),
    });

    expect(drill.state).toBe("completed");
    expect(drill.integrity?.passed).toBe(true);
    expect(drill.integrity?.objectsChecked).toBe(2);
    expect(drill.integrity?.objectHashMismatches).toBe(0);
    expect(drill.integrity?.tableRowMismatches).toEqual([]);
    expect(drill.continuity?.auditChainVerified).toBe("verified");
    expect(drill.continuity?.auditContinuityMarkerAppended).toBe(true);
    expect(drill.continuity?.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect(drill.continuity?.totpWatermarksAdvanced).toBeGreaterThanOrEqual(1);
    expect(drill.continuity?.passkeyCountersReconciled).toBeGreaterThanOrEqual(1);
    expect(drill.continuity?.recoveryCodesReconciled).toBeGreaterThanOrEqual(1);

    // 5. Inspect LIVE database: active customer session in LIVE DB must NOT have been revoked by isolated drill!
    const [liveSessionStillActive] = await tdb.db
      .select()
      .from(userSessions)
      .where(eq(userSessions.publicId, liveSessPublicId));
    expect(liveSessionStillActive?.revokedAt).toBeNull();

    // 6. Inspect ISOLATED restored database directly via mysql2 to prove §7.3 continuity invariants!
    const restoredConn = await mysql.createConnection({ uri: `${baseMysqlUrl()}/${isolatedDbName}` });
    try {
      const [sessRows] = await restoredConn.query<mysql.RowDataPacket[]>(
        "SELECT revoked_at, revoke_reason FROM user_sessions WHERE public_id = ?",
        [liveSessPublicId],
      );
      expect(sessRows[0]?.revoked_at).not.toBeNull();
      expect(sessRows[0]?.revoke_reason).toBe("restored_from_backup");

      const [tokRows] = await restoredConn.query<mysql.RowDataPacket[]>(
        "SELECT COUNT(*) AS cnt FROM identity_tokens WHERE consumed_at IS NULL",
      );
      expect(Number(tokRows[0]?.cnt)).toBe(0);

      const [chalRows] = await restoredConn.query<mysql.RowDataPacket[]>(
        "SELECT COUNT(*) AS cnt FROM assurance_challenges",
      );
      expect(Number(chalRows[0]?.cnt)).toBe(0);

      const [ticketRows] = await restoredConn.query<mysql.RowDataPacket[]>(
        "SELECT COUNT(*) AS cnt FROM file_download_tickets",
      );
      expect(Number(ticketRows[0]?.cnt)).toBe(0);

      // Anti-replay forward watermarks!
      const [mfaRows] = await restoredConn.query<mysql.RowDataPacket[]>(
        "SELECT last_totp_step FROM assurance_accounts WHERE user_id = ?",
        [customerUserId],
      );
      expect(Number(mfaRows[0]?.last_totp_step)).toBe(highTotpStep);

      const [pkRows] = await restoredConn.query<mysql.RowDataPacket[]>(
        "SELECT counter FROM assurance_passkeys WHERE user_id = ?",
        [customerUserId],
      );
      expect(Number(pkRows[0]?.counter)).toBe(19);

      const [rcRows] = await restoredConn.query<mysql.RowDataPacket[]>(
        "SELECT used_at FROM assurance_recovery_codes WHERE code_hash = ?",
        [recCodeHash1],
      );
      expect(rcRows[0]?.used_at).not.toBeNull();

      const [rlRows] = await restoredConn.query<mysql.RowDataPacket[]>(
        "SELECT hits FROM http_rate_limit_counters WHERE category = 'user_login' AND slot = 42",
      );
      expect(Number(rlRows[0]?.hits)).toBe(9);

      // Queued jobs & mail quarantined; external SIEM flag disabled!
      const [qJobs] = await restoredConn.query<mysql.RowDataPacket[]>(
        "SELECT state, reason_code FROM job_runs WHERE type = 'engagement.digest'",
      );
      expect(qJobs[0]?.state).toBe("canceled");
      expect(qJobs[0]?.reason_code).toBe("RESTORE_QUARANTINED");

      const [qMail] = await restoredConn.query<mysql.RowDataPacket[]>(
        "SELECT state, reason_code FROM mail_outbox WHERE template = 'orders.status_changed'",
      );
      expect(qMail[0]?.state).toBe("canceled");
      expect(qMail[0]?.reason_code).toBe("RESTORE_QUARANTINED");

      const [siemFlag] = await restoredConn.query<mysql.RowDataPacket[]>(
        "SELECT value_json FROM platform_settings WHERE setting_key = 'flag:siem.forwarding.enabled'",
      );
      expect(Boolean(siemFlag[0]?.value_json)).toBe(false);

      // Continuity audit marker appended to restored audit_events!
      const [markerRows] = await restoredConn.query<mysql.RowDataPacket[]>(
        "SELECT event_name, category, outcome FROM audit_events WHERE event_name = 'backup.restore.continuity_marker'",
      );
      expect(markerRows.length).toBe(1);
      expect(markerRows[0]?.category).toBe("backup");
      expect(markerRows[0]?.outcome).toBe("completed");
    } finally {
      await restoredConn.end();
    }

    // Verify restored private object bytes in isolated sandbox storage match byte-for-byte
    const restoredFileBytes = await readFile(path.join(sandboxRootDir, "drill-alpha", fileStorageKey));
    expect(restoredFileBytes.equals(secretCanaryPayload)).toBe(true);

    // 7. Also exercise `quarantine_credentials` mode on a second isolated DB
    const quarantineDbName = `rp_test_restore_${randomBytes(4).toString("hex")}`;
    createdRestoreDbs.push(quarantineDbName);
    const quarantineDrill = await realMod.restoreToIsolatedTarget(admin, {
      backupPublicId: archiveSummary.publicId,
      targetDatabaseName: quarantineDbName,
      targetStoragePath: "drill-quarantine",
      continuityMode: "quarantine_credentials",
      confirmationText: expectedRestoreConfirmationText(archiveSummary.publicId, quarantineDbName),
    });
    expect(quarantineDrill.state).toBe("completed");

    const qConn = await mysql.createConnection({ uri: `${baseMysqlUrl()}/${quarantineDbName}` });
    try {
      const [uRows] = await qConn.query<mysql.RowDataPacket[]>(
        "SELECT password_hash, must_change_password, status FROM users WHERE id = ?",
        [customerUserId],
      );
      expect(uRows[0]?.password_hash).toBeNull();
      expect(Boolean(uRows[0]?.must_change_password)).toBe(true);
      expect(uRows[0]?.status).toBe("pending_activation");
    } finally {
      await qConn.end();
    }
  }, 60_000);

  it("detects header bit-flips, ciphertext tampering, truncation, trailing bytes, and wrong keys before touching restore targets", async () => {
    const env: NodeJS.ProcessEnv = {
      RP_BACKUP_KEY_FILE: keyFilePath,
      RP_BACKUP_KEY_ID: "bk-primary-2026",
      RP_RECOVERY_SANDBOX_DIR: sandboxRootDir,
    };
    const { mod } = buildRealStorageHarness(env);
    const backup = await mod.runBackupDirect({ trigger: "manual", actorUserId: adminUserId });
    const [row] = await tdb.db.select().from(backupArchives).where(eq(backupArchives.publicId, backup.publicId));
    const archiveDiskPath = path.join(liveStorageDir, row!.storageKey!);
    const originalBytes = await readFile(archiveDiskPath);

    // 1. Ciphertext bit-flip in middle of file
    const flipped = Buffer.from(originalBytes);
    const mid = Math.floor(flipped.length / 2);
    flipped[mid] = (flipped[mid] ?? 0) ^ 0xff;
    await chmod(archiveDiskPath, 0o600);
    await writeFile(archiveDiskPath, flipped);

    await expect(mod.verifyBackupDirect(backup.publicId)).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "ARCHIVE_TAMPERED",
    });

    // Restore must reject in Pass 1 BEFORE creating the target database!
    const untouchableDb = `rp_test_restore_${randomBytes(4).toString("hex")}`;
    createdRestoreDbs.push(untouchableDb);
    await expect(
      mod.restoreToIsolatedTargetDirect({
        backupPublicId: backup.publicId,
        targetDatabaseName: untouchableDb,
        targetStorageDir: path.join(sandboxRootDir, "tampered-target"),
        confirmationText: expectedRestoreConfirmationText(backup.publicId, untouchableDb),
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "ARCHIVE_TAMPERED",
    });
    const adminConn = await mysql.createConnection({ uri: baseMysqlUrl() });
    const [dbExists] = await adminConn.query<mysql.RowDataPacket[]>(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
      [untouchableDb],
    );
    await adminConn.end();
    expect(dbExists.length).toBe(0);

    // 2. Truncated archive (chop off final 24 bytes -> missing final chunk flag / truncated GCM tag)
    await writeFile(archiveDiskPath, originalBytes.subarray(0, originalBytes.length - 24));
    await expect(mod.verifyBackupDirect(backup.publicId)).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "ARCHIVE_TAMPERED",
    });

    // 3. Appended trailing bytes after final chunk
    await writeFile(archiveDiskPath, Buffer.concat([originalBytes, Buffer.from("TRAILING_JUNK")]));
    await expect(mod.verifyBackupDirect(backup.publicId)).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "ARCHIVE_TAMPERED",
    });

    // 4. Restore original bytes, then verify with WRONG key
    await writeFile(archiveDiskPath, originalBytes);
    const wrongKeyMod = buildRealStorageHarness({
      RP_BACKUP_KEY: randomBytes(32).toString("base64"),
      RP_BACKUP_KEY_ID: "bk-primary-2026",
    }).mod;
    await expect(wrongKeyMod.verifyBackupDirect(backup.publicId)).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "ARCHIVE_TAMPERED",
    });

    // Restore clean verified state with right key
    const restoredVerify = await mod.verifyBackupDirect(backup.publicId);
    expect(restoredVerify.state).toBe("completed");
  }, 45_000);

  it("refuses live database target, non-empty target database, overlapping storage dir, and wrong confirmation phrase", async () => {
    const env: NodeJS.ProcessEnv = {
      RP_BACKUP_KEY_FILE: keyFilePath,
      RP_BACKUP_KEY_ID: "bk-primary-2026",
      RP_RECOVERY_SANDBOX_DIR: sandboxRootDir,
    };
    const { mod } = buildRealStorageHarness(env);
    const [latest] = await tdb.db
      .select()
      .from(backupArchives)
      .where(eq(backupArchives.state, "completed"))
      .limit(1);
    const backupId = latest!.publicId;

    // 1. Confirmation mismatch
    await expect(
      mod.restoreToIsolatedTargetDirect({
        backupPublicId: backupId,
        targetDatabaseName: "rp_test_restore_ok",
        targetStorageDir: path.join(sandboxRootDir, "wrong-confirm"),
        confirmationText: "RESTORE WRONG PHRASE",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      reasonCode: "CONFIRMATION_MISMATCH",
    });

    // 2. Live database name -> LIVE_TARGET_REFUSED
    await expect(
      mod.restoreToIsolatedTargetDirect({
        backupPublicId: backupId,
        targetDatabaseName: tdb.name,
        targetStorageDir: path.join(sandboxRootDir, "live-db-attempt"),
        confirmationText: expectedRestoreConfirmationText(backupId, tdb.name),
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "LIVE_TARGET_REFUSED",
    });

    // 3. Overlapping storage directory (inside liveStorageDir) -> LIVE_STORAGE_OVERLAP
    const overlapDb = `rp_test_restore_${randomBytes(4).toString("hex")}`;
    await expect(
      mod.restoreToIsolatedTargetDirect({
        backupPublicId: backupId,
        targetDatabaseName: overlapDb,
        targetStorageDir: path.join(liveStorageDir, "nested-restore"),
        confirmationText: expectedRestoreConfirmationText(backupId, overlapDb),
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "LIVE_STORAGE_OVERLAP",
    });

    // 4. Non-empty existing target database -> TARGET_DATABASE_NOT_EMPTY
    const populatedDb = `rp_test_restore_${randomBytes(4).toString("hex")}`;
    createdRestoreDbs.push(populatedDb);
    const adminConn = await mysql.createConnection({ uri: baseMysqlUrl() });
    await adminConn.query(`CREATE DATABASE \`${populatedDb}\``);
    await adminConn.query(`CREATE TABLE \`${populatedDb}\`.existing_data (id INT PRIMARY KEY)`);
    await adminConn.end();

    await expect(
      mod.restoreToIsolatedTargetDirect({
        backupPublicId: backupId,
        targetDatabaseName: populatedDb,
        targetStorageDir: path.join(sandboxRootDir, "non-empty-db"),
        confirmationText: expectedRestoreConfirmationText(backupId, populatedDb),
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "TARGET_DATABASE_NOT_EMPTY",
    });
  });

  it("protects last-known-good verified backup, active legal holds, and unknown outcomes during retention, and fails closed if audit fails", async () => {
    await tdb.db.delete(backupLegalHolds);
    await tdb.db.delete(backupVerifications);
    await tdb.db.delete(backupRestoreDrills);
    await tdb.db.delete(backupArchives);

    const env: NodeJS.ProcessEnv = { RP_BACKUP_KEY_FILE: keyFilePath };
    const { harness, deps, mod, realStorage } = buildRealStorageHarness(env);

    // Create 3 real completed backups + 1 unknown-outcome row
    const b1 = await mod.runBackupDirect({ actorUserId: adminUserId }); // oldest (T+0)
    await mod.verifyBackupDirect(b1.publicId);

    harness.clock.advance(86_400_000 * 10); // +10 days
    const b2 = await mod.runBackupDirect({ actorUserId: adminUserId }); // middle (T+10d)
    await mod.verifyBackupDirect(b2.publicId);

    harness.clock.advance(86_400_000 * 10); // +20 days
    const b3 = await mod.runBackupDirect({ actorUserId: adminUserId }); // newest verified = lastKnownGood! (T+20d)
    await mod.verifyBackupDirect(b3.publicId);

    // Insert an `unknown` state archive older than maxAgeDays
    const unknownId = ulid(deps.clock.now().getTime() - 86_400_000 * 90);
    await tdb.db.insert(backupArchives).values({
      publicId: unknownId,
      state: "unknown",
      reasonCode: "WORKER_LEASE_LOST",
      trigger: "scheduled",
      installationId: deps.config.installationId,
      releaseRef: deps.config.releaseRef,
      correlationId: unknownId,
      createdAt: new Date(deps.clock.now().getTime() - 86_400_000 * 90),
      updatedAt: new Date(deps.clock.now().getTime() - 86_400_000 * 90),
    });

    // Advance clock +40 days so ALL backups exceed maxAgeDays=5, and set keepLastCount=1!
    harness.clock.advance(86_400_000 * 40);
    const freshAdmin = makeAdminPrincipal({ stepUpAt: deps.clock.now() });
    await mod.updateRetentionPolicy(freshAdmin, {
      keepLastCount: 1,
      maxAgeDays: 5,
      scheduleEnabled: true,
      autoPruneEnabled: true,
    });

    // Place a legal hold on oldest backup `b1`
    const hold = await mod.createLegalHold(freshAdmin, {
      backupPublicId: b1.publicId,
      reasonCode: "INCIDENT_PRESERVATION",
      note: "Preserve oldest archive for synthetic incident drill.",
    });

    const [b2Before] = await tdb.db.select().from(backupArchives).where(eq(backupArchives.publicId, b2.publicId));
    const b2StorageKey = b2Before!.storageKey!;
    expect(await realStorage.stat(b2StorageKey)).not.toBeNull();

    // Cross-model Rule #3 Regression: if `audit.record` fails inside the retention transaction,
    // ZERO rows are marked purged and ZERO storage blobs are unlinked!
    harness.audit.failRecords = true;
    await expect(mod.runRetention(freshAdmin, { dryRun: false })).rejects.toThrow();
    harness.audit.failRecords = false;
    expect(await realStorage.stat(b2StorageKey)).not.toBeNull();

    // Now run retention normally: ONLY `b2` is pruned! `b3` (last_known_good), `b1` (legal_hold), `unknownId` (in_flight_or_unknown) survive!
    const ret1 = await mod.runRetention(freshAdmin, { dryRun: false });
    expect(ret1.prunedCount).toBe(1);
    const byId = new Map(ret1.items.map((i) => [i.backupPublicId, i]));
    expect(byId.get(b3.publicId)).toEqual(
      expect.objectContaining({ action: "keep", keepReason: "last_known_good" }),
    );
    expect(byId.get(b1.publicId)).toEqual(
      expect.objectContaining({ action: "keep", keepReason: "legal_hold" }),
    );
    expect(byId.get(unknownId)).toEqual(
      expect.objectContaining({ action: "keep", keepReason: "non_terminal_or_unknown" }),
    );
    expect(byId.get(b2.publicId)).toEqual(
      expect.objectContaining({ action: "prune", keepReason: null }),
    );
    expect(await realStorage.stat(b2StorageKey)).toBeNull();

    // Release hold on `b1` -> next retention run prunes `b1`, while `b3` STILL survives as last_known_good even past maxAgeDays!
    await mod.releaseLegalHold(freshAdmin, {
      holdPublicId: hold.publicId,
      releaseReasonCode: "DRILL_CLOSED",
    });
    const ret2 = await mod.runRetention(freshAdmin, { dryRun: false });
    expect(ret2.prunedCount).toBe(1);
    expect(ret2.items.find((i) => i.backupPublicId === b1.publicId)?.action).toBe("prune");
    expect(ret2.items.find((i) => i.backupPublicId === b3.publicId)?.keepReason).toBe("last_known_good");
  });

  it("never self-deadlocks on a 1-connection MySQL pool and rejects mid-flight session revocation or role downgrade inside transactions", async () => {
    // Cross-model Rule #1: 1-connection pool with real DB-backed SettingsStore + durable AuditEmitter!
    const singlePoolDb = createDatabase(tdb.url, 1);
    try {
      const base = createTestDeps({
        db: singlePoolDb.db,
        config: { storageDir: liveStorageDir, databaseUrl: tdb.url },
        now: new Date("2026-06-01T00:00:00.000Z"),
      });
      const realEmitter = createAuditEmitter({
        config: base.deps.config,
        db: singlePoolDb.db,
        clock: base.deps.clock,
        logger: base.deps.logger,
        crypto: base.deps.crypto,
      });
      const realSettingsStore = createSettingsStore({
        db: singlePoolDb.db,
        clock: base.deps.clock,
        logger: base.deps.logger,
        crypto: base.deps.crypto,
        audit: realEmitter,
      });
      const realStorage = createObjectStorage({
        config: { storageDir: liveStorageDir },
        logger: base.deps.logger,
      });
      const deps: ModuleDeps = {
        ...base.deps,
        db: singlePoolDb.db,
        settings: realSettingsStore,
        audit: realEmitter,
        storage: realStorage,
      };
      (deps.services as unknown as Record<string, unknown>).identity = buildIdentityStub();
      const singleConnMod = createBackupModule(deps, {
        env: { RP_BACKUP_KEY_FILE: keyFilePath, RP_RECOVERY_SANDBOX_DIR: sandboxRootDir },
        databaseUrlOverride: tdb.url,
      });

      const admin = makeAdminPrincipal({ stepUpAt: deps.clock.now() });

      // All of these open `db.transaction(...)`, lock actor, read/write settings, and write durable audit on the SAME single connection!
      await singleConnMod.updateRetentionPolicy(admin, {
        keepLastCount: 7,
        maxAgeDays: 30,
        scheduleEnabled: true,
      });
      const enqueued = await singleConnMod.enqueueBackup(admin, { trigger: "manual" });
      expect(enqueued.backupPublicId).toBeTruthy();
      const retentionRes = await singleConnMod.runRetention(admin, { dryRun: false });
      expect(retentionRes.items.length).toBeGreaterThanOrEqual(1);

      await singlePoolDb.db.delete(backupArchives).where(eq(backupArchives.publicId, enqueued.backupPublicId));

      // Cross-model Rule #2: Request starts with a valid admin SessionPrincipal snapshot,
      // BEFORE the transaction runs, the session is revoked or role downgraded -> must reject inside `tx`!
      const staleSessionAdmin = makeAdminPrincipal({ stepUpAt: deps.clock.now() });
      actorDirectory.get(staleSessionAdmin.sessionId)!.revoked = true;

      await expect(
        singleConnMod.updateRetentionPolicy(staleSessionAdmin, {
          keepLastCount: 99,
          maxAgeDays: 99,
          scheduleEnabled: false,
        }),
      ).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
        reasonCode: "SESSION_REVOKED",
      });

      const downgradedAdmin = makeAdminPrincipal({ stepUpAt: deps.clock.now() });
      actorDirectory.get(downgradedAdmin.sessionId)!.role = "staff";
      await expect(singleConnMod.enqueueBackup(downgradedAdmin)).rejects.toMatchObject({
        code: "FORBIDDEN",
        reasonCode: "CAPABILITY_REVOKED",
      });
    } finally {
      await singlePoolDb.close();
    }
  });

  it("enforces negative authorization matrix on tRPC router and streams encrypted downloads safely via HTTP", async () => {
    const env: NodeJS.ProcessEnv = { RP_BACKUP_KEY_FILE: keyFilePath };
    const { deps, mod } = buildRealStorageHarness(env);
    const appRouter = router({ backup: backupRouter });

    const noopTransport = { issue() {}, clear() {} };
    function callerFor(session: SessionPrincipal | null) {
      return appRouter.createCaller({
        request: newRequestContext("test"),
        session,
        transport: noopTransport,
        services: { ...deps.services, backup: mod } as Services,
      });
    }

    // 1. Unauthenticated -> UNAUTHORIZED
    await expect(callerFor(null).backup.admin.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    // 2. Customer -> FORBIDDEN
    const customer = fakePrincipal({ userId: customerUserId, role: "customer" });
    await expect(callerFor(customer).backup.admin.list()).rejects.toMatchObject({ code: "FORBIDDEN" });

    // 3. Staff -> FORBIDDEN
    const staff = fakePrincipal({ userId: customerUserId, role: "staff" });
    await expect(callerFor(staff).backup.admin.list()).rejects.toMatchObject({ code: "FORBIDDEN" });

    // 4. Admin with pending MFA enrollment -> FORBIDDEN (remediation required)
    const pendingMfaAdmin = makeAdminPrincipal({ state: "remediation", pendingSteps: ["enroll_mfa"] });
    await expect(callerFor(pendingMfaAdmin).backup.admin.list()).rejects.toMatchObject({ code: "FORBIDDEN" });

    // 5. Admin WITHOUT fresh step-up -> read succeeds, step-up mutations (`runNow`, `verify`, `restoreIsolated`, `runRetention`) reject!
    const staleStepUpAdmin = makeAdminPrincipal({
      stepUpAt: new Date(deps.clock.now().getTime() - 30 * 60 * 1000),
    });
    const listed = await callerFor(staleStepUpAdmin).backup.admin.list();
    expect(listed.items.length).toBeGreaterThanOrEqual(1);
    await expect(callerFor(staleStepUpAdmin).backup.admin.runNow()).rejects.toMatchObject({ code: "FORBIDDEN" });

    // 6. Raw HTTP download route: streams `.rpbk` with nosniff, no-store, attachment filename
    const targetBackupId = listed.items.find((i) => i.state === "completed")!.publicId;
    const sub = express.Router();
    registerBackupHttpRoutes(sub, { ...deps.services, backup: mod, clock: deps.clock } as Services);

    const freshAdmin = makeAdminPrincipal({ stepUpAt: deps.clock.now() });
    const chunks: Buffer[] = [];
    const headers = new Map<string, string>();
    let statusCode = 200;

    await new Promise<void>((resolve, reject) => {
      const fakeReq = Object.assign(
        new Readable({
          read() {
            this.push(null);
          },
        }),
        {
          method: "GET",
          url: `/archives/${targetBackupId}/download`,
          originalUrl: `/api/backup/archives/${targetBackupId}/download`,
          headers: {},
          params: { publicId: targetBackupId },
        },
      ) as unknown as express.Request;

      setHttpState(fakeReq, {
        context: newRequestContext("test"),
        session: freshAdmin,
        transport: noopTransport,
        cspNonce: "nonce123",
      });

      const fakeRes = Object.assign(
        new Writable({
          write(chunk: Buffer, _enc, cb) {
            chunks.push(Buffer.from(chunk));
            cb();
          },
          final(cb) {
            cb();
            resolve();
          },
        }),
        {
          headersSent: false,
          statusCode: 200,
          setHeader(k: string, v: string) {
            headers.set(k.toLowerCase(), String(v));
          },
          getHeader(k: string) {
            return headers.get(k.toLowerCase());
          },
          status(c: number) {
            statusCode = c;
            return this;
          },
        },
      ) as unknown as express.Response;

      sub(fakeReq, fakeRes, (err?: unknown) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve();
      });
    });

    expect(statusCode).toBe(200);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("content-disposition")).toContain(`readypackets-backup-${targetBackupId}.rpbk`);
    const downloadedBuf = Buffer.concat(chunks);
    expect(downloadedBuf.subarray(0, 8).toString("ascii")).toBe("RPBK0001");
  });
});
