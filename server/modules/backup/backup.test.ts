/**
 * End-to-end backup, verification, isolated restore, security-state continuity, tamper detection,
 * retention + legal holds, and cross-model transaction safety tests against real MySQL + mysqldump/mysql
 * + LocalObjectStorage. SYNTHETIC DATA ONLY (`*.example.test`).
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { eq } from "drizzle-orm";
import express from "express";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModuleDeps, Services } from "../../container.js";
import { conflict, DomainError } from "../../core/errors.js";
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
  executeIsolatedCliRestore,
  expectedRestoreConfirmationText,
} from "./index.js";
import { requireBackupKeyring } from "./keys.js";
import {
  assertNoLiveSchemaWritePrivilegeFromGrants,
  createPrivateDefaultsFile,
  parseValidatedMysqlTarget,
} from "./mysqlCli.js";
import { backupRouter } from "./router.js";
import {
  backupArchives,
  backupLegalHolds,
  backupRemoteCopies,
  backupRestoreDrills,
  backupVerifications,
} from "./schema.js";
import { z } from "zod";
import { entriesForEvent } from "../audit/triggerCatalogue.js";
import { getStaticAutomationRegistrations } from "../automations/contracts.js";
import { createStorageModule } from "../storage/index.js";
import {
  storageAssignments,
  storageConnections,
  storageCopyAttempts,
  storageFileCopies,
} from "../storage/schema.js";
import { BACKUP_JOB_REMOTE_COPY, BACKUP_JOB_REMOTE_SWEEP } from "./offsite.js";
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
  storageConnections,
  storageAssignments,
  storageCopyAttempts,
  storageFileCopies,
  backupArchives,
  backupVerifications,
  backupRestoreDrills,
  backupLegalHolds,
  backupRemoteCopies,
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
  let staffUserId = 0;
  let staffPublicId = "";

  // Dedicated target-scoped recovery MySQL credentials (`GRANT ALL PRIVILEGES ON \`rp_test_restore\_%\`.*` & `\`rp_vfy\_%\`.*`).
  let recoveryDbUser = "";
  let recoveryMysqlUrl = "";
  let allowSameUserFallback = false;

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

  async function execRootMysqlDdl(statements: string[]): Promise<boolean> {
    try {
      const rootConn = await mysql.createConnection({ uri: baseMysqlUrl() });
      try {
        for (const stmt of statements) {
          await rootConn.query(stmt);
        }
        return true;
      } finally {
        await rootConn.end();
      }
    } catch {
      try {
        execFileSync("sudo", ["-n", "mysql", "-u", "root", "-e", statements.join("; ")], {
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    }
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

    // Provision a dedicated target-scoped recovery MySQL user (`rp_dr_test_*`) with ZERO grants on `tdb.name`.
    const drSuffix = randomBytes(4).toString("hex");
    recoveryDbUser = `rp_dr_test_${drSuffix}`;
    const recoveryDbPass = `dr_pass_${randomBytes(12).toString("hex")}`;
    const parsedBase = new URL(`${baseMysqlUrl()}/rp_recovery_placeholder`);
    const provisioned = await execRootMysqlDdl([
      `CREATE USER IF NOT EXISTS '${recoveryDbUser}'@'localhost' IDENTIFIED BY '${recoveryDbPass}'`,
      `CREATE USER IF NOT EXISTS '${recoveryDbUser}'@'127.0.0.1' IDENTIFIED BY '${recoveryDbPass}'`,
      `CREATE USER IF NOT EXISTS '${recoveryDbUser}'@'%' IDENTIFIED BY '${recoveryDbPass}'`,
      `GRANT ALL PRIVILEGES ON \`rp_test_restore\\_%\`.* TO '${recoveryDbUser}'@'localhost'`,
      `GRANT ALL PRIVILEGES ON \`rp_test_restore\\_%\`.* TO '${recoveryDbUser}'@'127.0.0.1'`,
      `GRANT ALL PRIVILEGES ON \`rp_test_restore\\_%\`.* TO '${recoveryDbUser}'@'%'`,
      `GRANT ALL PRIVILEGES ON \`rp_vfy\\_%\`.* TO '${recoveryDbUser}'@'localhost'`,
      `GRANT ALL PRIVILEGES ON \`rp_vfy\\_%\`.* TO '${recoveryDbUser}'@'127.0.0.1'`,
      `GRANT ALL PRIVILEGES ON \`rp_vfy\\_%\`.* TO '${recoveryDbUser}'@'%'`,
      "FLUSH PRIVILEGES",
    ]);
    if (provisioned) {
      // Warm caching_sha2_password server cache via local mysql CLI over TCP before mysql2 (tls=off) connects.
      try {
        execFileSync(
          "mysql",
          [
            "--protocol=TCP",
            "-h",
            parsedBase.hostname,
            "-P",
            parsedBase.port || "3306",
            "-u",
            recoveryDbUser,
            `-p${recoveryDbPass}`,
            "-e",
            "SELECT 1",
          ],
          { stdio: "ignore" },
        );
      } catch {
        // Ignore if mysql client binary handles TLS differently; openValidatedMysqlConnection will verify.
      }
      recoveryMysqlUrl = `mysql://${recoveryDbUser}:${recoveryDbPass}@${parsedBase.hostname}:${parsedBase.port || "3306"}/rp_test_restore_placeholder?tls=off`;
      allowSameUserFallback = false;
    } else {
      recoveryMysqlUrl = `${baseMysqlUrl()}/rp_test_restore_placeholder?tls=off`;
      allowSameUserFallback = true;
    }

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

    staffPublicId = ulid(now.getTime() + 2);
    const [staffIns] = await tdb.db.insert(users).values({
      publicId: staffPublicId,
      emailEnc: h.deps.crypto.encrypt("bob.staff@portal.example.test", `users.email:${staffPublicId}`),
      emailIndex: h.deps.crypto.blindIndex("bob.staff@portal.example.test", "users.email"),
      nameEnc: h.deps.crypto.encrypt("Bob Staff", `users.name:${staffPublicId}`),
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$synthetic$synthetichash_staff_old",
      mustChangePassword: false,
      role: "staff",
      status: "active",
      emailVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    staffUserId = Number(staffIns.insertId);
  }, 60_000);

  afterAll(async () => {
    const admin = await mysql.createConnection({ uri: baseMysqlUrl() });
    for (const dbName of createdRestoreDbs) {
      if (/^rp_(test_restore|vfy)_[a-z0-9_]+$/.test(dbName)) {
        await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      }
    }
    await admin.end();
    if (recoveryDbUser && !allowSameUserFallback) {
      await execRootMysqlDdl([
        `DROP USER IF EXISTS '${recoveryDbUser}'@'localhost'`,
        `DROP USER IF EXISTS '${recoveryDbUser}'@'127.0.0.1'`,
        `DROP USER IF EXISTS '${recoveryDbUser}'@'%'`,
        "FLUSH PRIVILEGES",
      ]);
    }
    if (tdb) await tdb.cleanup();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  function buildRealStorageHarness(
    customEnv: NodeJS.ProcessEnv,
    customDb = tdb.db,
    recoveryUrlOverride?: string,
  ) {
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
      ...(recoveryUrlOverride !== undefined ? { recoveryDatabaseUrlOverride: recoveryUrlOverride } : {}),
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
    const realMod = createBackupModule(realDeps, {
      env,
      databaseUrlOverride: tdb.url,
      ...(allowSameUserFallback ? {} : { recoveryDatabaseUrlOverride: recoveryMysqlUrl }),
    });
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

    // Seed staff MFA + revocable passkey BEFORE backup so post-backup suspension/demotion/rotation/revocation can be tested!
    const staffAssurancePublicId = ulid(now.getTime() + 28);
    const staffRecoverySetId = ulid(now.getTime() + 29);
    await tdb.db.insert(assuranceAccounts).values({
      publicId: staffAssurancePublicId,
      userId: staffUserId,
      totpSecretEnc: deps.crypto.encrypt("KRSXG5CTMVRXEZLU", `assurance.totp:${staffAssurancePublicId}`),
      lastTotpStep: 80,
      recoverySetId: staffRecoverySetId,
      recoveryAcknowledgedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const revokedPasskeyPublicId = ulid(now.getTime() + 32);
    const revokedPasskeyIndex = randomBytes(32).toString("hex");
    await tdb.db.insert(assurancePasskeys).values({
      publicId: revokedPasskeyPublicId,
      userId: staffUserId,
      credentialId: "c3RhZmYtcmV2b2tlZC1jcmVkZW50aWFs",
      credentialIndex: revokedPasskeyIndex,
      publicKey: "c3RhZmYtcmV2b2tlZC1jb3NlLWtleQ",
      counter: 3,
      nameEnc: deps.crypto.encrypt("Lost Staff Key", `assurance.passkey:${revokedPasskeyPublicId}`),
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

    // 3. Simulate post-backup anti-replay & account lifecycle security events on the LIVE database BEFORE restoring:
    // - TOTP step advances well beyond floor(now / 30s) so we prove live watermark propagation;
    // - Staff account (`staffUserId`) is SUSPENDED, DEMOTED to customer, has password rotated, has TOTP secret rotated,
    //   and has its lost passkey deleted!
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

    const rotatedCustomerHash = "$argon2id$v=19$m=19456,t=2,p=1$synthetic$synthetichash_cust_ROTATED";
    await tdb.db
      .update(users)
      .set({ passwordHash: rotatedCustomerHash, mustChangePassword: true, updatedAt: postBackupNow })
      .where(eq(users.id, customerUserId));

    const rotatedStaffHash = "$argon2id$v=19$m=19456,t=2,p=1$synthetic$synthetichash_staff_ROTATED";
    const rotatedStaffTotpEnc = deps.crypto.encrypt("MFRGGZDFMZTWQ2LK", `assurance.totp:${staffAssurancePublicId}`);
    await tdb.db
      .update(users)
      .set({
        status: "suspended",
        role: "customer",
        passwordHash: rotatedStaffHash,
        mustChangePassword: true,
        updatedAt: postBackupNow,
      })
      .where(eq(users.id, staffUserId));
    await tdb.db
      .update(assuranceAccounts)
      .set({
        totpSecretEnc: rotatedStaffTotpEnc,
        lastTotpStep: highTotpStep + 10,
        updatedAt: postBackupNow,
      })
      .where(eq(assuranceAccounts.userId, staffUserId));
    await tdb.db.delete(assurancePasskeys).where(eq(assurancePasskeys.publicId, revokedPasskeyPublicId));

    // 4. Operator-only isolated restore (`preserve_continuity`) using dedicated target-scoped recovery credentials
    const isolatedDbName = `rp_test_restore_${randomBytes(4).toString("hex")}`;
    createdRestoreDbs.push(isolatedDbName);

    const drill = await realMod.restoreToIsolatedTargetDirect({
      backupPublicId: archiveSummary.publicId,
      targetDatabaseName: isolatedDbName,
      targetStorageDir: path.join(sandboxRootDir, "drill-alpha"),
      recoveryDatabaseUrl: recoveryMysqlUrl,
      continuityMode: "preserve_continuity",
      confirmationText: expectedRestoreConfirmationText(archiveSummary.publicId, isolatedDbName),
      actorUserId: adminUserId,
      ...(allowSameUserFallback ? { allowSameUserInTestOnly: true } : {}),
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

    // 6. Inspect ISOLATED restored database directly via mysql2 to prove §7.3 continuity + account lifecycle invariants!
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

      // Post-backup password rotation, account suspension, role demotion, MFA rotation, and passkey deletion reconciled:
      // historic pre-rotation password hashes and pre-rotation TOTP secrets are cleared fail-closed!
      const [custReconciled] = await restoredConn.query<mysql.RowDataPacket[]>(
        "SELECT password_hash, must_change_password FROM users WHERE public_id = ?",
        [customerPublicId],
      );
      expect(custReconciled[0]?.password_hash).toBeNull();
      expect(Boolean(custReconciled[0]?.must_change_password)).toBe(true);

      const [staffRows] = await restoredConn.query<mysql.RowDataPacket[]>(
        "SELECT status, role, password_hash, must_change_password FROM users WHERE public_id = ?",
        [staffPublicId],
      );
      expect(staffRows[0]?.status).toBe("suspended");
      expect(staffRows[0]?.role).toBe("customer");
      expect(staffRows[0]?.password_hash).toBeNull();
      expect(Boolean(staffRows[0]?.must_change_password)).toBe(true);

      const [staffMfaRows] = await restoredConn.query<mysql.RowDataPacket[]>(
        "SELECT totp_secret_enc FROM assurance_accounts WHERE public_id = ?",
        [staffAssurancePublicId],
      );
      expect(staffMfaRows[0]?.totp_secret_enc).toBeNull();

      const [revokedPkRows] = await restoredConn.query<mysql.RowDataPacket[]>(
        "SELECT COUNT(*) AS cnt FROM assurance_passkeys WHERE public_id = ?",
        [revokedPasskeyPublicId],
      );
      expect(Number(revokedPkRows[0]?.cnt)).toBe(0);

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

    // 7. Standalone OFFLINE `.rpbk` archive CLI restore (NO live DB ledger, defaults to `quarantine_credentials`)!
    const offlineDbName = `rp_test_restore_${randomBytes(4).toString("hex")}`;
    createdRestoreDbs.push(offlineDbName);
    const offlineArchivePath = path.join(liveStorageDir, dbArchiveRow!.storageKey!);
    const offlineKeyring = await requireBackupKeyring(null, { env });
    const offlineRes = await executeIsolatedCliRestore({
      archiveFilePath: offlineArchivePath,
      recoveryDatabaseUrl: recoveryMysqlUrl,
      targetDatabaseName: offlineDbName,
      targetStorageDir: path.join(sandboxRootDir, "drill-offline-quarantine"),
      confirmationText: expectedRestoreConfirmationText(archiveSummary.publicId, offlineDbName),
      keyring: offlineKeyring,
      config: deps.config,
      clock: deps.clock,
      logger: deps.logger,
      crypto: deps.crypto,
      guardLiveDatabaseUrl: tdb.url,
      guardLiveStorageDir: liveStorageDir,
      ...(allowSameUserFallback ? { allowSameUserInTestOnly: true } : {}),
    });
    expect(offlineRes.state).toBe("completed");
    expect(offlineRes.continuityMode).toBe("quarantine_credentials");
    expect(offlineRes.manualAccountReviewRequired).toBe(true);
    expect(offlineRes.continuity.auditChainVerified).toBe("verified");

    // Confirm canonical `createChainService.verifyRange()` passes on the standalone offline restored database!
    const offlineRestoredDb = createDatabase(`${baseMysqlUrl()}/${offlineDbName}`, 1);
    try {
      const offlineChain = createChainService({
        db: offlineRestoredDb.db,
        clock: deps.clock,
        logger: deps.logger,
        auditChainKey: deps.config.auditChainKey,
        installationId: deps.config.installationId,
      });
      const chainReport = await offlineChain.verify();
      expect(chainReport.ok).toBe(true);
    } finally {
      await offlineRestoredDb.close();
    }

    const qConn = await mysql.createConnection({ uri: `${baseMysqlUrl()}/${offlineDbName}` });
    try {
      const [uRows] = await qConn.query<mysql.RowDataPacket[]>(
        "SELECT password_hash, must_change_password, status FROM users WHERE id = ?",
        [customerUserId],
      );
      expect(uRows[0]?.password_hash).toBeNull();
      expect(Boolean(uRows[0]?.must_change_password)).toBe(true);
      expect(uRows[0]?.status).toBe("pending_activation");

      const [completedAuditRows] = await qConn.query<mysql.RowDataPacket[]>(
        "SELECT event_name FROM audit_events WHERE event_name = 'backup.restore.completed'",
      );
      expect(completedAuditRows.length).toBe(1);
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
        recoveryDatabaseUrl: recoveryMysqlUrl,
        confirmationText: expectedRestoreConfirmationText(backup.publicId, untouchableDb),
        ...(allowSameUserFallback ? { allowSameUserInTestOnly: true } : {}),
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

  it("refuses live database target, live credential reuse, over-broad grants, non-empty target database, overlapping storage dir, and wrong confirmation phrase", async () => {
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

    // 0. Live credential reuse (`recoveryDatabaseUrl: tdb.url`) -> LIVE_CREDENTIAL_REUSE_REFUSED
    await expect(
      mod.restoreToIsolatedTargetDirect({
        backupPublicId: backupId,
        targetDatabaseName: "rp_test_restore_samecred",
        targetStorageDir: path.join(sandboxRootDir, "same-cred"),
        recoveryDatabaseUrl: tdb.url,
        confirmationText: expectedRestoreConfirmationText(backupId, "rp_test_restore_samecred"),
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      reasonCode: "LIVE_CREDENTIAL_REUSE_REFUSED",
    });

    // 0b. Grant evaluator refuses `*.*` global write/DDL and wildcard live-schema grants (`rp\_%`), allows target-scoped grants
    expect(() =>
      assertNoLiveSchemaWritePrivilegeFromGrants(["GRANT ALL PRIVILEGES ON *.* TO `bad`@`%`"], tdb.name),
    ).toThrow(/RESTORE_PRIVILEGE_ISOLATION_VIOLATED/);
    expect(() =>
      assertNoLiveSchemaWritePrivilegeFromGrants(["GRANT ALL PRIVILEGES ON `rp\\_%`.* TO `bad`@`%`"], tdb.name),
    ).toThrow(/RESTORE_PRIVILEGE_ISOLATION_VIOLATED/);
    expect(() =>
      assertNoLiveSchemaWritePrivilegeFromGrants(
        [
          "GRANT USAGE ON *.* TO `rp_dr`@`%`",
          "GRANT ALL PRIVILEGES ON `rp_test_restore\\_%`.* TO `rp_dr`@`%`",
        ],
        tdb.name,
      ),
    ).not.toThrow();

    // 1. Confirmation mismatch
    await expect(
      mod.restoreToIsolatedTargetDirect({
        backupPublicId: backupId,
        targetDatabaseName: "rp_test_restore_ok",
        targetStorageDir: path.join(sandboxRootDir, "wrong-confirm"),
        recoveryDatabaseUrl: recoveryMysqlUrl,
        confirmationText: "RESTORE WRONG PHRASE",
        ...(allowSameUserFallback ? { allowSameUserInTestOnly: true } : {}),
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
        recoveryDatabaseUrl: recoveryMysqlUrl,
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
        recoveryDatabaseUrl: recoveryMysqlUrl,
        confirmationText: expectedRestoreConfirmationText(backupId, overlapDb),
        ...(allowSameUserFallback ? { allowSameUserInTestOnly: true } : {}),
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
        recoveryDatabaseUrl: recoveryMysqlUrl,
        confirmationText: expectedRestoreConfirmationText(backupId, populatedDb),
        ...(allowSameUserFallback ? { allowSameUserInTestOnly: true } : {}),
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

    // 5. Admin WITHOUT fresh step-up -> read succeeds, step-up mutations (`runNow`, `verify`, `runRetention`) reject!
    // Web-initiated restore (`restoreIsolated`) is permanently absent from the web/tRPC surface!
    expect("restoreIsolated" in (callerFor(null).backup.admin as Record<string, unknown>)).toBe(false);
    const staleStepUpAdmin = makeAdminPrincipal({
      stepUpAt: new Date(deps.clock.now().getTime() - 30 * 60 * 1000),
    });
    const listed = await callerFor(staleStepUpAdmin).backup.admin.list();
    expect(listed.items.length).toBeGreaterThanOrEqual(1);
    await expect(callerFor(staleStepUpAdmin).backup.admin.runNow()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(staleStepUpAdmin).backup.admin.runRetention({ dryRun: false }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

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

  it("enforces server/db/connectionOptions.ts TLS options for MySQL client defaults files, fenced lease checks, and crash-safe two-phase retention", async () => {
    // 1. Disallowed URL query params (`?ssl=false`, `?multipleStatements=true`) are rejected via connectionOptionsFromUrl
    expect(() => parseValidatedMysqlTarget("mysql://u:p@db.example.test:3306/rp_prod?ssl=false")).toThrow(
      expect.objectContaining({ reasonCode: "DATABASE_URL_INVALID" }),
    );
    expect(() =>
      parseValidatedMysqlTarget("mysql://u:p@db.example.test:3306/rp_prod?multipleStatements=true"),
    ).toThrow(expect.objectContaining({ reasonCode: "DATABASE_URL_INVALID" }));

    // 2. Valid `tls=required&tlsCaFile=...` produces a `0600` defaults file enforcing VERIFY_IDENTITY, TLSv1.2+, local-infile=0, TCP
    const caPath = path.join(tempRoot, "synthetic-ca.pem");
    await writeFile(caPath, "-----BEGIN CERTIFICATE-----\nU1lOVEhFVElDX0NB\n-----END CERTIFICATE-----\n", {
      mode: 0o600,
    });
    const validatedTls = parseValidatedMysqlTarget(
      `mysql://rp_user:s3cr3t@db.example.test:3306/rp_prod?tls=required&tlsCaFile=${encodeURIComponent(caPath)}`,
    );
    expect(validatedTls.tlsRequired).toBe(true);
    expect(validatedTls.tlsCaFile).toBe(caPath);
    const cnf = await createPrivateDefaultsFile(validatedTls);
    try {
      const cnfHandle = await open(cnf.filePath, "r");
      let cnfText: string;
      try {
        expect((await cnfHandle.stat()).mode & 0o777).toBe(0o600);
        cnfText = await cnfHandle.readFile("utf8");
      } finally {
        await cnfHandle.close();
      }
      expect(cnfText).toContain("protocol=TCP");
      expect(cnfText).toContain("local-infile=0");
      expect(cnfText).toContain("ssl-mode=VERIFY_IDENTITY");
      expect(cnfText).toContain("tls-version=TLSv1.2,TLSv1.3");
      expect(cnfText).toContain(`ssl-ca="${caPath}"`);
    } finally {
      await cnf.cleanup();
    }

    // 3. Fenced job lease check (`assertFence(tx)` throwing `JOB_LEASE_LOST`) aborts commit without marking archive completed
    const env: NodeJS.ProcessEnv = { RP_BACKUP_KEY_FILE: keyFilePath };
    const { harness, deps, mod, realStorage } = buildRealStorageHarness(env);
    await expect(
      mod.runBackupDirect({
        actorUserId: adminUserId,
        assertFence: async () => {
          throw conflict("JOB_LEASE_LOST", "This job no longer owns its lease.");
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "JOB_LEASE_LOST" });

    // 4. Two-phase crash-safe retention (`RETENTION_PURGE_PENDING`): if `storage.delete` fails after Phase 1 commit,
    // `storageKey` remains intact (`purgedAt === null`) and the next retention run finishes physical deletion!
    await tdb.db.delete(backupLegalHolds);
    await tdb.db.delete(backupVerifications);
    await tdb.db.delete(backupRestoreDrills);
    await tdb.db.delete(backupArchives);

    const oldBkp = await mod.runBackupDirect({ actorUserId: adminUserId });
    await mod.verifyBackupDirect(oldBkp.publicId);
    harness.clock.advance(86_400_000 * 15);
    const lkgBkp = await mod.runBackupDirect({ actorUserId: adminUserId });
    await mod.verifyBackupDirect(lkgBkp.publicId);
    harness.clock.advance(86_400_000 * 30);

    const freshAdmin = makeAdminPrincipal({ stepUpAt: deps.clock.now() });
    await mod.updateRetentionPolicy(freshAdmin, {
      keepLastCount: 1,
      maxAgeDays: 5,
      scheduleEnabled: true,
      autoPruneEnabled: true,
    });

    const [oldBefore] = await tdb.db.select().from(backupArchives).where(eq(backupArchives.publicId, oldBkp.publicId));
    const oldKey = oldBefore!.storageKey!;

    let failDeleteOnce = true;
    const origDelete = realStorage.delete.bind(realStorage);
    realStorage.delete = async (key: string) => {
      if (failDeleteOnce) {
        failDeleteOnce = false;
        throw new Error("Simulated transient disk unlink error");
      }
      return origDelete(key);
    };

    try {
      await expect(mod.runRetention(freshAdmin, { dryRun: false })).rejects.toMatchObject({
        code: "UNAVAILABLE",
        reasonCode: "RETENTION_STORAGE_DELETE_PARTIAL",
      });
      const [pendingRow] = await tdb.db
        .select()
        .from(backupArchives)
        .where(eq(backupArchives.publicId, oldBkp.publicId));
      expect(pendingRow?.reasonCode).toBe("RETENTION_PURGE_PENDING");
      expect(pendingRow?.storageKey).toBe(oldKey);
      expect(pendingRow?.purgedAt).toBeNull();
      expect(await realStorage.stat(oldKey)).not.toBeNull();

      // Retry retention -> finishes purging the `RETENTION_PURGE_PENDING` blob and sets `purgedAt`!
      const retryRun = await mod.runRetention(freshAdmin, { dryRun: false });
      expect(retryRun.prunedCount).toBe(1);
      const [purgedRow] = await tdb.db
        .select()
        .from(backupArchives)
        .where(eq(backupArchives.publicId, oldBkp.publicId));
      expect(purgedRow?.storageKey).toBeNull();
      expect(purgedRow?.purgedAt).not.toBeNull();
      expect(await realStorage.stat(oldKey)).toBeNull();
    } finally {
      realStorage.delete = origDelete;
    }
  });

  it("supports multi-destination 3-2-1 off-site copies, digest verification, retry/Copy now, non-deletion, and automation triggers", async () => {
    await tdb.db.delete(backupRemoteCopies);
    await tdb.db.delete(backupLegalHolds);
    await tdb.db.delete(backupVerifications);
    await tdb.db.delete(backupRestoreDrills);
    await tdb.db.delete(backupArchives);
    await tdb.db.delete(storageAssignments);
    await tdb.db.delete(storageConnections);

    const env: NodeJS.ProcessEnv = {
      RP_BACKUP_KEY_FILE: keyFilePath,
      RP_BACKUP_KEY_ID: "bk-321-2026",
      RP_RECOVERY_SANDBOX_DIR: sandboxRootDir,
    };
    const { harness, deps, mod, realStorage } = buildRealStorageHarness(env);
    mod.init?.();

    // 1. Verify all 6 backup triggers are registered in the automation registry.
    const registeredTriggers = getStaticAutomationRegistrations().triggers;
    for (const expectedKey of [
      "backup.completed",
      "backup.failed",
      "backup.verify_failed",
      "backup.remote_copy_completed",
      "backup.remote_copy_failed",
      "backup.policy_unmet",
    ]) {
      expect(registeredTriggers.has(expectedKey)).toBe(true);
    }

    // Wire real StorageModule with local in-memory fake cloud adapters (OneDrive + SharePoint + Dropbox; zero real cloud egress).
    const storageMod = createStorageModule(deps);
    (deps.services as unknown as Record<string, unknown>).storageConnections = storageMod;

    interface StoredRemoteBlob {
      connectionId: string;
      path: readonly string[];
      name: string;
      bytes: Buffer;
      sha256: string;
    }
    const remoteObjects = new Map<string, StoredRemoteBlob>();
    let failSecondDestPutOnce = false;

    const fakeConfigSchema = z.strictObject({ bucketLabel: z.string().min(1) });
    const fakeCredSchema = z.strictObject({ clientSecret: z.string().min(4) });

    for (const kind of ["onedrive", "sharepoint", "dropbox"] as const) {
      storageMod.registerAdapter(kind, {
        configSchema: fakeConfigSchema,
        credentialsSchema: fakeCredSchema,
        purposes: ["order_files", "backups"],
        create: ({ publicId }) => ({
          async test() {
            return { ok: true, code: "OK" as const };
          },
          async ensureFolder() {},
          async remove() {},
          async put(input) {
            const chunks: Buffer[] = [];
            for await (const chunk of input.body) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
            }
            const bytes = Buffer.concat(chunks);
            if (kind === "sharepoint" && failSecondDestPutOnce) {
              failSecondDestPutOnce = false;
              throw new DomainError("UNAVAILABLE", "STORAGE_UPSTREAM_FAILURE", "Simulated transient upstream 503");
            }
            const digest = createHash("sha256").update(bytes).digest("hex");
            const remoteKey = `${publicId}:${input.path.join("/")}/${input.name}`;
            remoteObjects.set(remoteKey, {
              connectionId: publicId,
              path: input.path,
              name: input.name,
              bytes,
              sha256: digest,
            });
            return {
              remoteId: `secret-provider-uri://${kind}/${remoteKey}`,
              size: bytes.length,
              ...(kind === "sharepoint"
                ? { verifiedTransportDigest: "quickxor" as const }
                : { sha256: digest }),
            };
          },
        }),
      });
    }

    const admin = makeAdminPrincipal({ stepUpAt: deps.clock.now() });

    // 2. Shipped disabled by default: 0 destinations, autoCopyAfterVerify false, 3-2-1 unmet.
    const initialCfg = await mod.getOffsiteConfig(admin);
    expect(initialCfg.autoCopyAfterVerify).toBe(false);
    expect(initialCfg.destinations).toHaveLength(0);
    expect(initialCfg.status321.overallMet).toBe(false);

    // Create 3 local-fake cloud storage connections, test them, and enable them.
    const s3Created = await storageMod.connections.create(admin, {
      kind: "onedrive",
      name: "Offsite OneDrive Vault",
      config: { bucketLabel: "vault-a" },
      credentials: { clientSecret: "tok-od-synthetic" },
    });
    const s3Tested = await storageMod.connections.test(admin, {
      publicId: s3Created.publicId,
      expectedVersion: s3Created.version,
    });
    const s3Conn = await storageMod.connections.update(admin, {
      publicId: s3Tested.publicId,
      expectedVersion: s3Tested.version,
      enabled: true,
    });

    const azCreated = await storageMod.connections.create(admin, {
      kind: "sharepoint",
      name: "Offsite SharePoint Archive",
      config: { bucketLabel: "vault-b" },
      credentials: { clientSecret: "tok-sp-synthetic" },
    });
    const azTested = await storageMod.connections.test(admin, {
      publicId: azCreated.publicId,
      expectedVersion: azCreated.version,
    });
    const azureConn = await storageMod.connections.update(admin, {
      publicId: azTested.publicId,
      expectedVersion: azTested.version,
      enabled: true,
    });

    const dbxCreated = await storageMod.connections.create(admin, {
      kind: "dropbox",
      name: "Secondary Dropbox Hold",
      config: { bucketLabel: "vault-c" },
      credentials: { clientSecret: "tok-dbx-synthetic" },
    });
    const dbxTested = await storageMod.connections.test(admin, {
      publicId: dbxCreated.publicId,
      expectedVersion: dbxCreated.version,
    });
    const dropboxConn = await storageMod.connections.update(admin, {
      publicId: dbxTested.publicId,
      expectedVersion: dbxTested.version,
      enabled: true,
    });

    // 3. Configure Off-site copies (S3 enabled, Azure enabled, Dropbox assigned but toggled OFF, autoCopyAfterVerify ON).
    // Configuration alone MUST NOT satisfy any 3-2-1 condition!
    const savedCfg = await mod.updateOffsiteConfig(admin, {
      autoCopyAfterVerify: true,
      windowDays: 7,
      destinations: [
        {
          connectionPublicId: s3Conn.publicId,
          assigned: true,
          enabled: true,
          retentionNote: "S3 Object Lock Compliance 90 days",
        },
        {
          connectionPublicId: azureConn.publicId,
          assigned: true,
          enabled: true,
          retentionNote: "Azure immutable blob policy 90 days",
        },
        {
          connectionPublicId: dropboxConn.publicId,
          assigned: true,
          enabled: false,
          retentionNote: "Paused secondary destination",
        },
      ],
    });
    expect(savedCfg.autoCopyAfterVerify).toBe(true);
    expect(savedCfg.status321.overallMet).toBe(false);
    expect(savedCfg.status321.threeCopiesMet).toBe(false);
    expect(savedCfg.status321.twoSystemsMet).toBe(false);
    expect(savedCfg.status321.oneOffsiteMet).toBe(false);

    // 4. Unverified archive MUST be refused by manual Copy now (`ARCHIVE_NOT_VERIFIED`).
    const createdArchive = await mod.runBackupDirect({
      actorUserId: adminUserId,
      correlationId: "automation:run_origin_preserved_01",
    });
    await expect(
      mod.copyOffsiteNow(admin, { backupPublicId: createdArchive.publicId }),
    ).rejects.toMatchObject({ code: "CONFLICT", reasonCode: "ARCHIVE_NOT_VERIFIED" });
    expect(remoteObjects.size).toBe(0);

    // 5. Verify archive -> automatically stages remote copy jobs for OneDrive + SharePoint (not disabled Dropbox), preserving correlationId!
    failSecondDestPutOnce = true;
    await mod.verifyBackupDirect(createdArchive.publicId, {
      actorUserId: adminUserId,
      correlationId: "automation:run_origin_preserved_01",
    });

    const remoteJobs = harness.jobs.enqueued.filter((j) => j.type === BACKUP_JOB_REMOTE_COPY);
    expect(remoteJobs).toHaveLength(2);
    for (const j of remoteJobs) {
      expect(j.options?.correlationId).toBe("automation:run_origin_preserved_01");
    }

    // Run both queued remote copy jobs: S3 succeeds (SHA-256 verified), Azure fails transiently (triggers backup.remote_copy.failed + backup.policy.unmet).
    await harness.jobs.runAll(BACKUP_JOB_REMOTE_COPY);

    const afterPartial = await mod.getOffsiteConfig(admin);
    expect(afterPartial.status321.verifiedCopies).toBe(2); // 1 local + 1 S3
    expect(afterPartial.status321.twoSystemsMet).toBe(true); // local_disk + s3
    expect(afterPartial.status321.oneOffsiteMet).toBe(true); // 1 off-site
    expect(afterPartial.status321.threeCopiesMet).toBe(false); // 2 < 3!
    expect(afterPartial.status321.overallMet).toBe(false);

    // Confirm audit events match TRIGGER_CATALOGUE (`backup.remote_copy_completed`, `backup.remote_copy_failed`, `backup.policy_unmet`)
    // and never expose `secret-provider-uri://`!
    const serializedAudit = JSON.stringify(harness.audit.events);
    expect(serializedAudit).not.toContain("secret-provider-uri://");

    const completedCopyAudit = harness.audit.events.find((e) => e.eventName === "backup.remote_copy.completed");
    expect(completedCopyAudit).toBeDefined();
    expect(completedCopyAudit?.correlationId).toBe("automation:run_origin_preserved_01");
    expect(
      entriesForEvent({
        eventId: "ae_1",
        eventName: completedCopyAudit!.eventName,
        category: "backup",
        action: "remote_copy.completed",
        outcome: completedCopyAudit!.outcome,
        reasonCode: completedCopyAudit!.reasonCode ?? null,
        occurredAt: new Date().toISOString(),
        actor: {
          userId: completedCopyAudit!.actor?.userId ?? null,
          role: completedCopyAudit!.actor?.role ?? "system",
        },
        resource: completedCopyAudit!.resource
          ? { type: completedCopyAudit!.resource.type, publicId: completedCopyAudit!.resource.publicId ?? null }
          : null,
        correlationId: completedCopyAudit!.correlationId ?? "corr",
        jobId: null,
        attributes: (completedCopyAudit!.attributes ?? {}) as Record<string, string | number | boolean | null>,
        safeCounts: completedCopyAudit!.safeCounts ?? {},
      }).map((e) => e.key),
    ).toContain("backup.remote_copy_completed");

    const unmetAudit = harness.audit.events.find((e) => e.eventName === "backup.policy.unmet");
    expect(unmetAudit).toBeDefined();
    expect(
      entriesForEvent({
        eventId: "ae_2",
        eventName: unmetAudit!.eventName,
        category: "backup",
        action: "policy.unmet",
        outcome: unmetAudit!.outcome,
        reasonCode: unmetAudit!.reasonCode ?? null,
        occurredAt: new Date().toISOString(),
        actor: { userId: null, role: "system" },
        resource: { type: "backup_policy", publicId: null },
        correlationId: "corr",
        jobId: null,
        attributes: (unmetAudit!.attributes ?? {}) as Record<string, string | number | boolean | null>,
        safeCounts: unmetAudit!.safeCounts ?? {},
      }).map((e) => e.key),
    ).toContain("backup.policy_unmet");

    // 6. Retry failed Azure destination via guarded `expectedFailedJobId` + `mayRetryOffsiteCopy` -> reaches 3 verified copies across 3 systems -> 3-2-1 MET!
    const [failedAzRow] = await tdb.db
      .select()
      .from(backupRemoteCopies)
      .where(eq(backupRemoteCopies.connectionPublicId, azureConn.publicId));
    const failedAzJobId = failedAzRow!.jobPublicId!;

    await tdb.db.transaction(async (tx) => {
      expect(
        await mod.mayRetryOffsiteCopy(
          { backupPublicId: createdArchive.publicId, connectionPublicId: azureConn.publicId, jobPublicId: "job_stale_00" },
          tx,
        ),
      ).toBe(false);
      expect(
        await mod.mayRetryOffsiteCopy(
          { backupPublicId: createdArchive.publicId, connectionPublicId: azureConn.publicId, jobPublicId: failedAzJobId },
          tx,
        ),
      ).toBe(true);
    });

    await expect(
      mod.copyOffsiteNow(admin, {
        backupPublicId: createdArchive.publicId,
        connectionPublicId: azureConn.publicId,
        expectedFailedJobId: "job_stale_00",
      }),
    ).rejects.toMatchObject({ reasonCode: "COPY_RETRY_STALE" });

    const retryQueued = await mod.copyOffsiteNow(admin, {
      backupPublicId: createdArchive.publicId,
      connectionPublicId: azureConn.publicId,
      expectedFailedJobId: failedAzJobId,
    });
    expect(retryQueued.queued).toHaveLength(1);
    expect(retryQueued.queued[0]?.state).toBe("queued");

    const [retryResult] = await harness.jobs.runAll(BACKUP_JOB_REMOTE_COPY);
    expect(retryResult?.outcome).toBe("completed");

    const recordedAttempts = await tdb.db
      .select()
      .from(storageCopyAttempts)
      .where(eq(storageCopyAttempts.sourcePublicId, createdArchive.publicId));
    expect(recordedAttempts.filter((a) => a.state === "verified" && a.verification === "checksum")).toHaveLength(2);
    expect(recordedAttempts.some((a) => a.state === "failed")).toBe(true);

    const afterRetry = await mod.getOffsiteConfig(admin);
    expect(afterRetry.status321.verifiedCopies).toBe(3);
    expect(afterRetry.status321.storageSystems).toBe(3);
    expect(afterRetry.status321.offsiteVerifiedCopies).toBe(2);
    expect(afterRetry.status321.threeCopiesMet).toBe(true);
    expect(afterRetry.status321.twoSystemsMet).toBe(true);
    expect(afterRetry.status321.oneOffsiteMet).toBe(true);
    expect(afterRetry.status321.overallMet).toBe(true);

    const detailView = await mod.getBackup(admin, createdArchive.publicId);
    expect(detailView.remoteCopies).toHaveLength(2);
    expect(JSON.stringify(detailView)).not.toContain("secret-provider-uri://");
    const s3Summary = detailView.remoteCopies.find((c) => c.connectionPublicId === s3Conn.publicId)!;
    const azSummary = detailView.remoteCopies.find((c) => c.connectionPublicId === azureConn.publicId)!;
    expect(s3Summary).toMatchObject({ state: "completed", digestVerified: true, verifiedDigestKind: "sha256" });
    expect(azSummary).toMatchObject({
      state: "completed",
      digestVerified: true,
      verifiedDigestKind: "quickxor",
      attemptCount: 2,
    });

    // Verify uploaded bytes start with `RPBK0001` encrypted magic (never plaintext)!
    for (const stored of remoteObjects.values()) {
      expect(stored.bytes.subarray(0, 8).toString("ascii")).toBe("RPBK0001");
      expect(stored.sha256).toBe(createdArchive.archiveSha256);
    }

    // 7. Wire-level unencrypted guard: if a local object is overwritten with plaintext bytes after verification,
    // remote copy refuses with `UNENCRYPTED_OR_INVALID_ARCHIVE` BEFORE calling StorageAdapter.put!
    await mod.updateOffsiteConfig(admin, {
      autoCopyAfterVerify: false,
      windowDays: 7,
      destinations: [
        { connectionPublicId: s3Conn.publicId, assigned: true, enabled: true },
        { connectionPublicId: azureConn.publicId, assigned: true, enabled: true },
        { connectionPublicId: dropboxConn.publicId, assigned: true, enabled: true },
      ],
    });
    const secondArchive = await mod.runBackupDirect({ actorUserId: adminUserId });
    await mod.verifyBackupDirect(secondArchive.publicId, { actorUserId: adminUserId });
    const [secondRow] = await tdb.db
      .select()
      .from(backupArchives)
      .where(eq(backupArchives.publicId, secondArchive.publicId));
    // Overwrite local file on disk with unencrypted bytes to test the wire-level RPBK0001 gate:
    await realStorage.delete(secondRow!.storageKey!);
    await realStorage.put(secondRow!.storageKey!, Readable.from([Buffer.from("PLAINTEXT_SQL_DUMP_FORBIDDEN!", "utf8")]));

    const objectsBeforeTamperedCopy = remoteObjects.size;
    await mod.copyOffsiteNow(admin, {
      backupPublicId: secondArchive.publicId,
      connectionPublicId: dropboxConn.publicId,
    });
    const [tamperRes] = await harness.jobs.runAll(BACKUP_JOB_REMOTE_COPY);
    expect(tamperRes).toMatchObject({ outcome: "failed", reasonCode: "UNENCRYPTED_OR_INVALID_ARCHIVE" });
    expect(remoteObjects.size).toBe(objectsBeforeTamperedCopy);

    // 8. Worker sweep picks up CLI-verified backups when autoCopyAfterVerify is true, and local retention pruning NEVER deletes remote copies!
    await mod.updateOffsiteConfig(admin, {
      autoCopyAfterVerify: true,
      windowDays: 7,
      destinations: [
        { connectionPublicId: s3Conn.publicId, assigned: true, enabled: true },
        { connectionPublicId: azureConn.publicId, assigned: true, enabled: true },
      ],
    });
    await harness.jobs.enqueue(BACKUP_JOB_REMOTE_SWEEP, {});
    const [sweepRes] = await harness.jobs.runAll(BACKUP_JOB_REMOTE_SWEEP);
    expect(sweepRes?.outcome).toBe("completed");

    // Advance clock & prune old archive locally -> remoteObjects and backup_remote_copies rows remain 100% intact!
    const remoteCountBeforePrune = remoteObjects.size;
    harness.clock.advance(86_400_000 * 20);
    const freshAdmin = makeAdminPrincipal({ stepUpAt: deps.clock.now() });
    const newestArchive = await mod.runBackupDirect({ actorUserId: adminUserId });
    await mod.verifyBackupDirect(newestArchive.publicId, { actorUserId: adminUserId });
    await mod.updateRetentionPolicy(freshAdmin, {
      keepLastCount: 1,
      maxAgeDays: 5,
      scheduleEnabled: true,
      autoPruneEnabled: true,
    });
    await mod.runRetention(freshAdmin, { dryRun: false });
    expect(remoteObjects.size).toBeGreaterThanOrEqual(remoteCountBeforePrune);
    const [preservedCopyRows] = await tdb.db
      .select()
      .from(backupRemoteCopies)
      .where(eq(backupRemoteCopies.backupId, secondRow!.id));
    expect(preservedCopyRows).toBeDefined();
  });
});
