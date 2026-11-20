/**
 * Siem module — public service surface and factory. Owner: siem module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.siem` at call time.
 */
import { performance } from "node:perf_hooks";
import { and, asc, desc, eq, inArray, lte, or, isNull, sql } from "drizzle-orm";
import { STEP_UP_CAPABILITIES, roleHasCapability, type Capability } from "../../../shared/capabilities.js";
import type { ModuleDeps, Services } from "../../container.js";
import { DomainError, conflict, forbidden, notFound, validation } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
import { getRequestContext } from "../../core/requestContext.js";
import type {
  AuditCategory,
  ClaimedJob,
  HealthState,
  JobResult,
  ModuleHealth,
  SessionPrincipal,
  Severity,
  Tx,
} from "../../core/types.js";
import { STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";
import { computeRetryBackoffMs } from "./backoff.js";
import { isSiemOperationalSelfEvent, matchesDestinationFilter, sanitizeProjectedEvent } from "./projection.js";
import { siemDestinations, siemOutbox, type SiemDestinationRow, type SiemOutboxRow } from "./schema.js";
import {
  SIEM_BATCH_SIZE,
  SIEM_CIRCUIT_COOLDOWN_SECONDS,
  SIEM_CIRCUIT_THRESHOLD,
  SIEM_MAX_ATTEMPTS,
  SIEM_OLDEST_ALERT_SECONDS,
  SIEM_SPOOL_MAX_EVENTS,
  deleteDestinationSecrets,
  parseCaBundleAndExpiry,
  prepareDestinationSecrets,
  readDestinationSecrets,
  validateAuthSecretValue,
  validateClientCertAndKeyPair,
} from "./settings.js";
import {
  SiemTlsConnectionPool,
  type SiemTransportError,
  classifySocketError,
  deliverProjectedBatch,
  resolvePinnedTarget,
  type TransportDestinationConfig,
} from "./transport.js";
import type {
  AuditReadPort,
  CreateSiemDestinationInput,
  ExternalAuditEvent,
  IntegrationsEgressPort,
  SiemCircuitState,
  SiemDeadLetterItem,
  SiemDeliveryCycleResult,
  SiemDestinationSummary,
  SiemFormat,
  SiemModule,
  SiemReceiptConfirmation,
  SiemTestResult,
  UpdateSiemDestinationInput,
} from "./types.js";
import {
  createDestinationSchema,
  deleteDestinationSchema,
  destinationPublicIdSchema,
  listDeadLettersSchema,
  normalizeAndValidateHost,
  normalizeAuthHeaderName,
  normalizeOtlpPath,
  purgeDeadLettersSchema,
  replayDeadLettersSchema,
  setEnabledSchema,
  updateDestinationSchema,
} from "./validation.js";

export * from "./types.js";
export {
  computeSyslogPri,
  escapeSdParamValue,
  formatRfc3339UtcMs,
  formatRfc5424Message,
  frameOctetCounted,
  neutralizeControls,
  otelSeverityToSyslog,
  sanitizePrintUsAscii,
  truncateUtf8Buffer,
  UTF8_BOM_BYTES,
} from "./rfc5424.js";
export {
  escapeCefExtensionValue,
  escapeCefHeaderField,
  formatCefSyslogFrame,
  formatJsonlRecord,
  formatOtlpLogsPayload,
} from "./formats.js";
export { sanitizeProjectedEvent, matchesDestinationFilter } from "./projection.js";

const CERT_EXPIRY_WARN_MS = 14 * 24 * 60 * 60 * 1_000;
const LEASE_DURATION_MS = 60_000;

interface IdentityAssertPort {
  sessions?: {
    assertCurrent?: (principal: SessionPrincipal, tx: Tx) => Promise<{ pendingSteps: readonly string[] }>;
    getState?: (
      sessionId: string,
      opts?: { tx?: Tx },
    ) => Promise<{
      live: boolean;
      role: SessionPrincipal["role"];
      userStatus: string;
      stepUpAt: Date | null;
    } | null>;
  };
  getUser?: (
    userId: number,
    opts?: { tx?: Tx; forUpdate?: boolean },
  ) => Promise<{ status: string; role: SessionPrincipal["role"] } | null>;
}

interface JobsAdminPort {
  isDraining?: () => Promise<boolean>;
}

function getAuditPort(services: Services): AuditReadPort | undefined {
  const candidate = services.auditCenter as unknown as Partial<AuditReadPort> | undefined;
  if (candidate && typeof candidate.readEventsAfter === "function") {
    return candidate as AuditReadPort;
  }
  return undefined;
}

function getEgressPort(services: Services): IntegrationsEgressPort | undefined {
  const candidate = services.integrations as unknown as { egress?: IntegrationsEgressPort } | undefined;
  return candidate?.egress;
}

function getIdentityPort(services: Services): IdentityAssertPort | undefined {
  return services.identity as unknown as IdentityAssertPort | undefined;
}

function getJobsAdminPort(services: Services): JobsAdminPort | undefined {
  return services.jobAdmin as unknown as JobsAdminPort | undefined;
}

function isStepUpFresh(stepUpAt: Date | null, now: Date): boolean {
  if (!stepUpAt) return false;
  const age = now.getTime() - stepUpAt.getTime();
  return age >= 0 && age <= STEP_UP_MAX_AGE_MS;
}

function assertPrincipalSnapshot(principal: SessionPrincipal | null | undefined, capability: Capability, now: Date): void {
  if (!principal) {
    throw new DomainError("UNAUTHENTICATED", "NO_SESSION", "Please sign in to continue.");
  }
  if (principal.state !== "full" || principal.pendingSteps.length > 0) {
    throw new DomainError(
      "REMEDIATION_REQUIRED",
      "ACCOUNT_STEP_PENDING",
      "Please finish securing your account to continue.",
    );
  }
  if (!roleHasCapability(principal.role, capability)) {
    throw forbidden("CAPABILITY_NOT_GRANTED");
  }
  if (STEP_UP_CAPABILITIES.has(capability) && !isStepUpFresh(principal.stepUpAt, now)) {
    throw new DomainError(
      "STEP_UP_REQUIRED",
      "STEP_UP_REQUIRED",
      "Please confirm your password and authentication code to continue.",
      { capability },
    );
  }
}

/**
 * Re-validates the privileged actor inside the active DB transaction (lock order: `users` -> `user_sessions`
 * BEFORE locking any `siem_*` row) so revoked sessions, demoted roles, or suspended accounts fail closed.
 */
async function assertActorCurrentInTx(
  deps: ModuleDeps,
  principal: SessionPrincipal,
  capability: Capability,
  now: Date,
  tx: Tx,
): Promise<void> {
  assertPrincipalSnapshot(principal, capability, now);
  const identity = getIdentityPort(deps.services);
  if (!identity) return;

  if (identity.sessions?.assertCurrent) {
    const { pendingSteps } = await identity.sessions.assertCurrent(principal, tx);
    if (pendingSteps.length > 0) {
      throw new DomainError(
        "REMEDIATION_REQUIRED",
        "ACCOUNT_STEP_PENDING",
        "Please finish securing your account to continue.",
      );
    }
  }

  if (identity.sessions?.getState) {
    const state = await identity.sessions.getState(principal.sessionId, { tx });
    if (!state || !state.live || state.userStatus !== "active") {
      throw new DomainError("UNAUTHENTICATED", "SESSION_NOT_CURRENT", "Your session is no longer active.");
    }
    if (!roleHasCapability(state.role, capability)) {
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
    if (STEP_UP_CAPABILITIES.has(capability) && !isStepUpFresh(state.stepUpAt, now)) {
      throw new DomainError(
        "STEP_UP_REQUIRED",
        "STEP_UP_REQUIRED",
        "Please confirm your password and authentication code to continue.",
        { capability },
      );
    }
    return;
  }

  if (identity.getUser) {
    const user = await identity.getUser(principal.userId, { tx, forUpdate: true });
    if (!user || user.status !== "active") {
      throw new DomainError("UNAUTHENTICATED", "SESSION_NOT_CURRENT", "Your account is no longer active.");
    }
    if (!roleHasCapability(user.role, capability)) {
      throw forbidden("CAPABILITY_NOT_GRANTED");
    }
  }
}

function toTransportConfig(row: SiemDestinationRow, deploymentProfile: string): TransportDestinationConfig {
  return {
    publicId: row.publicId,
    version: row.version,
    format: row.format as SiemFormat,
    host: row.host,
    port: row.port,
    otlpPath: row.otlpPath,
    allowPrivateNetwork: row.allowPrivateNetwork,
    facility: row.facility,
    appName: row.appName,
    hostnameOverride: row.hostnameOverride,
    enterpriseNumber: row.enterpriseNumber,
    sdIdName: row.sdIdName,
    includeBom: row.includeBom,
    maxMessageBytes: row.maxMessageBytes,
    connectTimeoutMs: row.connectTimeoutMs,
    writeTimeoutMs: row.writeTimeoutMs,
    authHeaderName: row.authHeaderName,
    deploymentProfile,
  };
}

interface OutboxStatsForDest {
  queuedCount: number;
  deadLetterCount: number;
  oldestQueuedCreatedAt: Date | null;
}

function parseDeadLetterCursor(cursor: string | undefined): { id: number } | null {
  if (!cursor) return null;
  const match = /^dl:(\d{1,18})$/.exec(cursor.trim());
  if (!match) throw validation("INVALID_CURSOR", "The pagination cursor is not valid.");
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id <= 0) throw validation("INVALID_CURSOR", "The pagination cursor is not valid.");
  return { id };
}

export function createSiemModule(deps: ModuleDeps): SiemModule {
  const pool = new SiemTlsConnectionPool();
  // Rate-limit spool saturation operational audit events per destination (max once per 10 minutes).
  const lastSaturationAuditMs = new Map<string, number>();

  async function recordDenialAndThrow(principal: SessionPrincipal | null | undefined, capability: Capability): Promise<never> {
    const now = deps.clock.now();
    try {
      assertPrincipalSnapshot(principal, capability, now);
    } catch (err) {
      if (err instanceof DomainError && (err.code === "UNAUTHENTICATED" || err.code === "FORBIDDEN" || err.code === "REMEDIATION_REQUIRED")) {
        try {
          await deps.audit.record({
            category: "security",
            eventName: "authz.access.denied",
            action: "authorize",
            outcome: "denied",
            severity: "WARN",
            reasonCode: err.reasonCode,
            actor: principal ? { userId: principal.userId, role: principal.role } : { role: "anonymous" },
            resource: { type: "siem_module" },
            attributes: { capability },
          });
        } catch {
          // Denial stands even if audit store is unavailable.
        }
      }
      throw err;
    }
    throw forbidden();
  }

  async function ensureAuthorized(principal: SessionPrincipal, capability: Capability): Promise<void> {
    const now = deps.clock.now();
    try {
      assertPrincipalSnapshot(principal, capability, now);
    } catch {
      await recordDenialAndThrow(principal, capability);
    }
  }

  async function loadOutboxStatsByDestination(destinationIds: readonly number[]): Promise<Map<number, OutboxStatsForDest>> {
    const map = new Map<number, OutboxStatsForDest>();
    if (destinationIds.length === 0) return map;
    const rows = await deps.db
      .select({
        destinationId: siemOutbox.destinationId,
        state: siemOutbox.state,
        count: sql<number>`COUNT(*)`,
        oldestCreatedAt: sql<Date | string | null>`MIN(${siemOutbox.createdAt})`,
      })
      .from(siemOutbox)
      .where(inArray(siemOutbox.destinationId, [...destinationIds]))
      .groupBy(siemOutbox.destinationId, siemOutbox.state);

    for (const r of rows) {
      const entry = map.get(r.destinationId) ?? { queuedCount: 0, deadLetterCount: 0, oldestQueuedCreatedAt: null };
      const cnt = Number(r.count ?? 0);
      if (r.state === "queued") {
        entry.queuedCount = cnt;
        if (r.oldestCreatedAt) {
          const d = r.oldestCreatedAt instanceof Date ? r.oldestCreatedAt : new Date(r.oldestCreatedAt);
          if (!Number.isNaN(d.getTime())) entry.oldestQueuedCreatedAt = d;
        }
      } else if (r.state === "dead_letter") {
        entry.deadLetterCount = cnt;
      }
      map.set(r.destinationId, entry);
    }
    return map;
  }

  async function currentAuditHeadSeq(): Promise<number> {
    const auditPort = getAuditPort(deps.services);
    if (!auditPort) return 0;
    try {
      // Cheap headSeq probe with limit=1 from null only if needed; better: readEventsAfter(lastCursor, 1) returns headSeq.
      const res = await auditPort.readEventsAfter(null, 1);
      return res.headSeq;
    } catch {
      return 0;
    }
  }

  function mapDestinationSummary(
    row: SiemDestinationRow,
    stats: OutboxStatsForDest | undefined,
    headSeq: number,
    now: Date,
  ): SiemDestinationSummary {
    const queuedCount = stats?.queuedCount ?? 0;
    const deadLetterCount = stats?.deadLetterCount ?? 0;
    const oldestQueuedAgeSeconds =
      stats?.oldestQueuedCreatedAt !== null && stats?.oldestQueuedCreatedAt !== undefined
        ? Math.max(0, Math.floor((now.getTime() - stats.oldestQueuedCreatedAt.getTime()) / 1_000))
        : null;
    const lagSeq = row.enabled ? Math.max(0, headSeq - row.lastProjectedSeq) : 0;

    return {
      publicId: row.publicId,
      name: row.name,
      enabled: row.enabled,
      format: row.format as SiemFormat,
      host: row.host,
      port: row.port,
      otlpPath: row.otlpPath,
      allowPrivateNetwork: row.allowPrivateNetwork,
      facility: row.facility,
      appName: row.appName,
      hostnameOverride: row.hostnameOverride,
      enterpriseNumber: row.enterpriseNumber,
      sdIdName: row.sdIdName,
      includeBom: row.includeBom,
      maxMessageBytes: row.maxMessageBytes,
      connectTimeoutMs: row.connectTimeoutMs,
      writeTimeoutMs: row.writeTimeoutMs,
      minSeverity: row.minSeverity as Severity,
      categories: [...(row.categoriesJson ?? [])],
      authHeaderName: row.authHeaderName,
      secrets: {
        hasCustomCa: row.hasCustomCa,
        hasClientCert: row.hasClientCert,
        hasClientKey: row.hasClientKey,
        hasAuthSecret: row.hasAuthSecret,
        caCertExpiresAt: row.caCertExpiresAt,
        clientCertExpiresAt: row.clientCertExpiresAt,
        updatedAt: row.secretUpdatedAt,
      },
      delivery: {
        circuitState: row.circuitState as SiemCircuitState,
        consecutiveFailures: row.consecutiveFailures,
        circuitOpenUntil: row.circuitOpenUntil,
        lastProjectedSeq: row.lastProjectedSeq,
        lagSeq,
        queuedCount,
        deadLetterCount,
        oldestQueuedAgeSeconds,
        lastAttemptAt: row.lastAttemptAt,
        lastSuccessAt: row.lastSuccessAt,
        lastFailureAt: row.lastFailureAt,
        lastFailureReason: row.lastFailureReason,
        deliveredCount: row.deliveredCount,
        failedAttemptCount: row.failedAttemptCount,
        deadLetteredCount: row.deadLetteredCount,
        lastTestAt: row.lastTestAt,
        lastTestOutcome: (row.lastTestOutcome as "completed" | "failed" | "unknown" | null) ?? null,
        lastTestReason: row.lastTestReason,
        receiptConfirmation: (row.receiptConfirmation as SiemReceiptConfirmation) ?? "none",
      },
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function preflightEgressOrThrow(config: TransportDestinationConfig): Promise<void> {
    try {
      await resolvePinnedTarget(config, getEgressPort(deps.services));
    } catch (err) {
      const classified = classifySocketError(err, false);
      if (classified.reasonCode === "EGRESS_BLOCKED") {
        throw validation(
          "EGRESS_BLOCKED",
          "That destination address or port is blocked by the outbound egress policy.",
        );
      }
      if (classified.reasonCode === "DNS_RESOLUTION_FAILED") {
        throw validation("DNS_RESOLUTION_FAILED", "The receiver hostname could not be resolved.");
      }
      throw validation("DESTINATION_UNREACHABLE", "The receiver endpoint did not pass outbound validation.");
    }
  }

  function preValidateSecretSyntax(secrets: CreateSiemDestinationInput["secrets"]): void {
    if (!secrets) return;
    if (secrets.customCaPem && secrets.customCaPem.trim() !== "") {
      parseCaBundleAndExpiry(secrets.customCaPem);
    }
    const hasCertPatch = secrets.clientCertPem !== undefined && secrets.clientCertPem !== null && secrets.clientCertPem.trim() !== "";
    const hasKeyPatch = secrets.clientKeyPem !== undefined && secrets.clientKeyPem !== null && secrets.clientKeyPem.trim() !== "";
    if (hasCertPatch && hasKeyPatch) {
      validateClientCertAndKeyPair(secrets.clientCertPem!, secrets.clientKeyPem!);
    }
    if (secrets.authSecret && secrets.authSecret.trim() !== "") {
      validateAuthSecretValue(secrets.authSecret);
    }
  }

  async function listDestinations(principal: SessionPrincipal): Promise<SiemDestinationSummary[]> {
    await ensureAuthorized(principal, "siem.read");
    const now = deps.clock.now();
    const rows = await deps.db.select().from(siemDestinations).orderBy(asc(siemDestinations.name), asc(siemDestinations.id));
    const [statsMap, headSeq] = await Promise.all([
      loadOutboxStatsByDestination(rows.map((r) => r.id)),
      currentAuditHeadSeq(),
    ]);
    return rows.map((row) => mapDestinationSummary(row, statsMap.get(row.id), headSeq, now));
  }

  async function getDestination(principal: SessionPrincipal, rawPublicId: string): Promise<SiemDestinationSummary> {
    await ensureAuthorized(principal, "siem.read");
    const { publicId } = destinationPublicIdSchema.parse({ publicId: rawPublicId });
    const now = deps.clock.now();
    const [row] = await deps.db.select().from(siemDestinations).where(eq(siemDestinations.publicId, publicId)).limit(1);
    if (!row) throw notFound("DESTINATION_NOT_FOUND");
    const [statsMap, headSeq] = await Promise.all([loadOutboxStatsByDestination([row.id]), currentAuditHeadSeq()]);
    return mapDestinationSummary(row, statsMap.get(row.id), headSeq, now);
  }

  async function createDestination(
    principal: SessionPrincipal,
    rawInput: CreateSiemDestinationInput,
  ): Promise<SiemDestinationSummary> {
    await ensureAuthorized(principal, "siem.manage");
    const input = createDestinationSchema.parse(rawInput);
    const host = normalizeAndValidateHost(input.host);
    const defaultPort = input.format === "otlp_https" ? 4318 : 6514;
    const port = input.port ?? defaultPort;
    const otlpPath = normalizeOtlpPath(input.otlpPath, input.format);
    const authHeaderName = normalizeAuthHeaderName(input.authHeaderName, input.format);
    const enabled = input.enabled ?? false;
    const allowPrivateNetwork = input.allowPrivateNetwork ?? false;
    const facility = input.facility ?? 16;
    const appName = input.appName ?? "readypackets";
    const hostnameOverride =
      input.hostnameOverride && input.hostnameOverride.trim().length > 0 ? input.hostnameOverride.trim() : null;
    const enterpriseNumber = input.enterpriseNumber ?? null;
    const sdIdName = input.sdIdName ?? "rp";
    const includeBom = input.includeBom ?? true;
    const maxMessageBytes = input.maxMessageBytes ?? 8192;
    const connectTimeoutMs = input.connectTimeoutMs ?? 5000;
    const writeTimeoutMs = input.writeTimeoutMs ?? 10000;
    const minSeverity = input.minSeverity ?? "INFO";
    const categories = [...new Set(input.categories)];

    preValidateSecretSyntax(input.secrets);

    const now = deps.clock.now();
    const publicId = ulid(now.getTime());

    // External DNS/egress preflight BEFORE opening DB transaction (no connection held during DNS I/O).
    if (enabled) {
      await preflightEgressOrThrow({
        publicId,
        version: 1,
        format: input.format,
        host,
        port,
        otlpPath,
        allowPrivateNetwork,
        facility,
        appName,
        hostnameOverride,
        enterpriseNumber,
        sdIdName,
        includeBom,
        maxMessageBytes,
        connectTimeoutMs,
        writeTimeoutMs,
        authHeaderName,
        deploymentProfile: deps.config.deploymentProfile,
      });
    }

    const reqCtx = getRequestContext();

    await deps.db.transaction(async (tx) => {
      await assertActorCurrentInTx(deps, principal, "siem.manage", now, tx);

      const [existingByName] = await tx
        .select({ id: siemDestinations.id })
        .from(siemDestinations)
        .where(eq(siemDestinations.name, input.name))
        .for("update")
        .limit(1);
      if (existingByName) {
        throw conflict("DESTINATION_NAME_IN_USE", "A SIEM destination with that name already exists.");
      }

      const preparedSecrets = await prepareDestinationSecrets(
        deps.settings,
        deps.crypto,
        publicId,
        input.secrets ?? {},
        tx,
      );
      const validatedTls = preparedSecrets.material;
      const anySecretSaved = Boolean(
        validatedTls.customCaPem || validatedTls.clientCertPem || validatedTls.clientKeyPem || validatedTls.authSecret,
      );

      await tx.insert(siemDestinations).values({
        publicId,
        name: input.name,
        enabled,
        format: input.format,
        host,
        port,
        otlpPath,
        allowPrivateNetwork,
        facility,
        appName,
        hostnameOverride,
        enterpriseNumber,
        sdIdName,
        includeBom,
        maxMessageBytes,
        connectTimeoutMs,
        writeTimeoutMs,
        minSeverity,
        categoriesJson: categories,
        authHeaderName,
        hasCustomCa: validatedTls.customCaPem !== null,
        hasClientCert: validatedTls.clientCertPem !== null,
        hasClientKey: validatedTls.clientKeyPem !== null,
        hasAuthSecret: validatedTls.authSecret !== null,
        caCertExpiresAt: validatedTls.caCertExpiresAt,
        clientCertExpiresAt: validatedTls.clientCertExpiresAt,
        secretUpdatedAt: anySecretSaved ? now : null,
        createdByUserId: principal.userId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });

      await deps.audit.record(
        {
          category: "admin",
          eventName: "siem.destination.created",
          action: "create",
          outcome: "completed",
          severity: "INFO",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "siem_destination", publicId },
          attributes: {
            format: input.format,
            port,
            enabled,
            allow_private_network: allowPrivateNetwork,
            min_severity: minSeverity,
            has_custom_ca: validatedTls.customCaPem !== null,
            has_mtls: validatedTls.clientCertPem !== null,
          },
          safeCounts: { categories: categories.length },
          occurredAt: now,
        },
        tx,
      );

      await preparedSecrets.persist();

      if (enabled) {
        await deps.jobs.enqueue(
          "siem.deliver",
          { destinationPublicId: publicId },
          {
            idempotencyKey: `siem.enable:${publicId}:v1`,
            correlationId: reqCtx?.correlationId ?? reqCtx?.requestId,
          },
          tx,
        );
      }
    });

    return getDestination(principal, publicId);
  }

  async function updateDestination(
    principal: SessionPrincipal,
    rawInput: UpdateSiemDestinationInput,
  ): Promise<SiemDestinationSummary> {
    await ensureAuthorized(principal, "siem.manage");
    const input = updateDestinationSchema.parse(rawInput);
    preValidateSecretSyntax(input.secrets);

    // Read current destination outside tx so DNS/egress preflight can execute BEFORE opening the transaction.
    const [snapshot] = await deps.db
      .select()
      .from(siemDestinations)
      .where(eq(siemDestinations.publicId, input.publicId))
      .limit(1);
    if (!snapshot) throw notFound("DESTINATION_NOT_FOUND");

    const nextFormat = (input.format ?? snapshot.format) as SiemFormat;
    const nextHost = input.host !== undefined ? normalizeAndValidateHost(input.host) : snapshot.host;
    const nextPort = input.port ?? snapshot.port;
    const nextOtlpPath =
      input.otlpPath !== undefined || input.format !== undefined
        ? normalizeOtlpPath(input.otlpPath !== undefined ? input.otlpPath : snapshot.otlpPath, nextFormat)
        : snapshot.otlpPath;
    const nextAuthHeader =
      input.authHeaderName !== undefined || input.format !== undefined
        ? normalizeAuthHeaderName(
            input.authHeaderName !== undefined ? input.authHeaderName : snapshot.authHeaderName,
            nextFormat,
          )
        : snapshot.authHeaderName;
    const nextEnabled = input.enabled ?? snapshot.enabled;
    const nextAllowPrivate = input.allowPrivateNetwork ?? snapshot.allowPrivateNetwork;
    const nextFacility = input.facility ?? snapshot.facility;
    const nextAppName = input.appName ?? snapshot.appName;
    const nextHostnameOverride =
      input.hostnameOverride === undefined
        ? snapshot.hostnameOverride
        : input.hostnameOverride && input.hostnameOverride.trim().length > 0
          ? input.hostnameOverride.trim()
          : null;
    const nextEnterpriseNumber =
      input.enterpriseNumber === undefined ? snapshot.enterpriseNumber : input.enterpriseNumber;
    const nextSdIdName = input.sdIdName ?? snapshot.sdIdName;
    const nextIncludeBom = input.includeBom ?? snapshot.includeBom;
    const nextMaxBytes = input.maxMessageBytes ?? snapshot.maxMessageBytes;
    const nextConnectTimeout = input.connectTimeoutMs ?? snapshot.connectTimeoutMs;
    const nextWriteTimeout = input.writeTimeoutMs ?? snapshot.writeTimeoutMs;
    const nextMinSeverity = input.minSeverity ?? (snapshot.minSeverity as Severity);
    const nextCategories = input.categories ? [...new Set(input.categories)] : [...snapshot.categoriesJson];

    if (nextEnabled) {
      await preflightEgressOrThrow({
        publicId: snapshot.publicId,
        version: snapshot.version + 1,
        format: nextFormat,
        host: nextHost,
        port: nextPort,
        otlpPath: nextOtlpPath,
        allowPrivateNetwork: nextAllowPrivate,
        facility: nextFacility,
        appName: nextAppName,
        hostnameOverride: nextHostnameOverride,
        enterpriseNumber: nextEnterpriseNumber,
        sdIdName: nextSdIdName,
        includeBom: nextIncludeBom,
        maxMessageBytes: nextMaxBytes,
        connectTimeoutMs: nextConnectTimeout,
        writeTimeoutMs: nextWriteTimeout,
        authHeaderName: nextAuthHeader,
        deploymentProfile: deps.config.deploymentProfile,
      });
    }

    const now = deps.clock.now();
    const reqCtx = getRequestContext();

    await deps.db.transaction(async (tx) => {
      await assertActorCurrentInTx(deps, principal, "siem.manage", now, tx);

      const [locked] = await tx
        .select()
        .from(siemDestinations)
        .where(eq(siemDestinations.publicId, input.publicId))
        .for("update")
        .limit(1);
      if (!locked) throw notFound("DESTINATION_NOT_FOUND");
      if (locked.version !== input.expectedVersion) {
        throw conflict("VERSION_MISMATCH", "This destination was modified by another session. Reload and try again.");
      }

      const nextName = input.name ?? locked.name;
      if (nextName !== locked.name) {
        const [dup] = await tx
          .select({ id: siemDestinations.id })
          .from(siemDestinations)
          .where(eq(siemDestinations.name, nextName))
          .for("update")
          .limit(1);
        if (dup && dup.id !== locked.id) {
          throw conflict("DESTINATION_NAME_IN_USE", "A SIEM destination with that name already exists.");
        }
      }

      const preparedSecrets = await prepareDestinationSecrets(
        deps.settings,
        deps.crypto,
        locked.publicId,
        input.secrets,
        tx,
      );
      const validatedTls = preparedSecrets.material;
      const nextVersion = locked.version + 1;

      await tx
        .update(siemDestinations)
        .set({
          name: nextName,
          enabled: nextEnabled,
          format: nextFormat,
          host: nextHost,
          port: nextPort,
          otlpPath: nextOtlpPath,
          allowPrivateNetwork: nextAllowPrivate,
          facility: nextFacility,
          appName: nextAppName,
          hostnameOverride: nextHostnameOverride,
          enterpriseNumber: nextEnterpriseNumber,
          sdIdName: nextSdIdName,
          includeBom: nextIncludeBom,
          maxMessageBytes: nextMaxBytes,
          connectTimeoutMs: nextConnectTimeout,
          writeTimeoutMs: nextWriteTimeout,
          minSeverity: nextMinSeverity,
          categoriesJson: nextCategories,
          authHeaderName: nextAuthHeader,
          hasCustomCa: validatedTls.customCaPem !== null,
          hasClientCert: validatedTls.clientCertPem !== null,
          hasClientKey: validatedTls.clientKeyPem !== null,
          hasAuthSecret: validatedTls.authSecret !== null,
          caCertExpiresAt: validatedTls.caCertExpiresAt,
          clientCertExpiresAt: validatedTls.clientCertExpiresAt,
          secretUpdatedAt: input.secrets !== undefined ? now : locked.secretUpdatedAt,
          // Reset open circuit on configuration repair so recovery is probed promptly.
          circuitState: locked.circuitState === "open" ? "half_open" : locked.circuitState,
          circuitOpenUntil: locked.circuitState === "open" ? null : locked.circuitOpenUntil,
          version: nextVersion,
          updatedAt: now,
        })
        .where(eq(siemDestinations.id, locked.id));

      await deps.audit.record(
        {
          category: "admin",
          eventName: "siem.destination.updated",
          action: "update",
          outcome: "completed",
          severity: "INFO",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "siem_destination", publicId: locked.publicId },
          attributes: {
            format: nextFormat,
            port: nextPort,
            enabled: nextEnabled,
            allow_private_network: nextAllowPrivate,
            min_severity: nextMinSeverity,
            secrets_modified: input.secrets !== undefined,
            has_custom_ca: validatedTls.customCaPem !== null,
            has_mtls: validatedTls.clientCertPem !== null,
            version: nextVersion,
          },
          safeCounts: { categories: nextCategories.length },
          occurredAt: now,
        },
        tx,
      );

      await preparedSecrets.persist();

      if (nextEnabled) {
        await deps.jobs.enqueue(
          "siem.deliver",
          { destinationPublicId: locked.publicId },
          {
            idempotencyKey: `siem.update:${locked.publicId}:v${nextVersion}`,
            correlationId: reqCtx?.correlationId ?? reqCtx?.requestId,
          },
          tx,
        );
      }
    });

    pool.evict(input.publicId);
    return getDestination(principal, input.publicId);
  }

  async function setDestinationEnabled(
    principal: SessionPrincipal,
    rawInput: { publicId: string; enabled: boolean; expectedVersion: number },
  ): Promise<SiemDestinationSummary> {
    await ensureAuthorized(principal, "siem.manage");
    const input = setEnabledSchema.parse(rawInput);

    const [snapshot] = await deps.db
      .select()
      .from(siemDestinations)
      .where(eq(siemDestinations.publicId, input.publicId))
      .limit(1);
    if (!snapshot) throw notFound("DESTINATION_NOT_FOUND");

    if (input.enabled) {
      await preflightEgressOrThrow(toTransportConfig(snapshot, deps.config.deploymentProfile));
    }

    const now = deps.clock.now();
    const reqCtx = getRequestContext();

    await deps.db.transaction(async (tx) => {
      await assertActorCurrentInTx(deps, principal, "siem.manage", now, tx);

      const [locked] = await tx
        .select()
        .from(siemDestinations)
        .where(eq(siemDestinations.publicId, input.publicId))
        .for("update")
        .limit(1);
      if (!locked) throw notFound("DESTINATION_NOT_FOUND");
      if (locked.version !== input.expectedVersion) {
        throw conflict("VERSION_MISMATCH", "This destination was modified by another session. Reload and try again.");
      }

      const nextVersion = locked.version + 1;
      await tx
        .update(siemDestinations)
        .set({
          enabled: input.enabled,
          circuitState: input.enabled && locked.circuitState === "open" ? "half_open" : locked.circuitState,
          circuitOpenUntil: input.enabled && locked.circuitState === "open" ? null : locked.circuitOpenUntil,
          version: nextVersion,
          updatedAt: now,
        })
        .where(eq(siemDestinations.id, locked.id));

      await deps.audit.record(
        {
          category: "security",
          eventName: input.enabled ? "siem.destination.enabled" : "siem.destination.disabled",
          action: "update",
          outcome: "completed",
          severity: input.enabled ? "INFO" : "WARN",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "siem_destination", publicId: locked.publicId },
          attributes: { enabled: input.enabled, version: nextVersion },
          occurredAt: now,
        },
        tx,
      );

      if (input.enabled) {
        await deps.jobs.enqueue(
          "siem.deliver",
          { destinationPublicId: locked.publicId },
          {
            idempotencyKey: `siem.toggle:${locked.publicId}:v${nextVersion}`,
            correlationId: reqCtx?.correlationId ?? reqCtx?.requestId,
          },
          tx,
        );
      }
    });

    if (!input.enabled) pool.evict(input.publicId);
    return getDestination(principal, input.publicId);
  }

  async function deleteDestination(
    principal: SessionPrincipal,
    rawInput: { publicId: string; expectedVersion: number },
  ): Promise<void> {
    await ensureAuthorized(principal, "siem.manage");
    const input = deleteDestinationSchema.parse(rawInput);
    const now = deps.clock.now();

    await deps.db.transaction(async (tx) => {
      await assertActorCurrentInTx(deps, principal, "siem.manage", now, tx);

      const [locked] = await tx
        .select()
        .from(siemDestinations)
        .where(eq(siemDestinations.publicId, input.publicId))
        .for("update")
        .limit(1);
      if (!locked) throw notFound("DESTINATION_NOT_FOUND");
      if (locked.version !== input.expectedVersion) {
        throw conflict("VERSION_MISMATCH", "This destination was modified by another session. Reload and try again.");
      }

      const [spoolCountRow] = await tx
        .select({ count: sql<number>`COUNT(*)` })
        .from(siemOutbox)
        .where(eq(siemOutbox.destinationId, locked.id));
      const removedSpoolItems = Number(spoolCountRow?.count ?? 0);

      // Rule 3: Write durable audit record BEFORE executing deletes inside the same transaction.
      await deps.audit.record(
        {
          category: "security",
          eventName: "siem.destination.deleted",
          action: "delete",
          outcome: "completed",
          severity: "WARN",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "siem_destination", publicId: locked.publicId },
          attributes: { format: locked.format, was_enabled: locked.enabled },
          safeCounts: { removed_outbox_items: removedSpoolItems },
          occurredAt: now,
        },
        tx,
      );

      await deleteDestinationSecrets(deps.settings, locked.publicId, tx);
      await tx.delete(siemOutbox).where(eq(siemOutbox.destinationId, locked.id));
      await tx.delete(siemDestinations).where(eq(siemDestinations.id, locked.id));
    });

    pool.evict(input.publicId);
  }

  async function sendTestEvent(principal: SessionPrincipal, rawInput: { publicId: string }): Promise<SiemTestResult> {
    await ensureAuthorized(principal, "siem.read");
    const { publicId } = destinationPublicIdSchema.parse(rawInput);
    const [row] = await deps.db.select().from(siemDestinations).where(eq(siemDestinations.publicId, publicId)).limit(1);
    if (!row) throw notFound("DESTINATION_NOT_FOUND");

    const startedAt = deps.clock.now();
    const startPerfMs = performance.now();
    const testEventId = ulid(startedAt.getTime());
    const reqCtx = getRequestContext();

    // Record durable intent (`attempted`) BEFORE making the external TLS connection.
    await deps.audit.record({
      category: "integration",
      eventName: "siem.destination.test",
      action: "test",
      outcome: "attempted",
      severity: "INFO",
      actor: { userId: principal.userId, role: principal.role },
      resource: { type: "siem_destination", publicId: row.publicId },
      deliveryId: testEventId,
      attributes: { format: row.format },
      occurredAt: startedAt,
    });

    const syntheticEvent: ExternalAuditEvent = sanitizeProjectedEvent({
      schema_version: "rp.audit/1",
      event_id: testEventId,
      chain_seq: null,
      occurred_at: startedAt.toISOString(),
      observed_at: startedAt.toISOString(),
      severity_text: "INFO",
      severity_number: 9,
      category: "system",
      event_name: "siem.connectivity.test",
      action: "test",
      outcome: "completed",
      reason_code: null,
      service: deps.config.serviceName,
      installation_ref: deps.config.installationId,
      release_ref: deps.config.releaseRef,
      deployment_profile: deps.config.deploymentProfile,
      origin: "http",
      actor_ref: deps.crypto.pseudonym(String(principal.userId), "audit.actor"),
      actor_role: principal.role,
      resource_type: "siem_destination",
      resource_ref: deps.crypto.pseudonym(row.publicId, "audit.resource"),
      source_address_class: null,
      request_id: reqCtx?.requestId ?? null,
      trace_id: reqCtx?.traceId ?? null,
      span_id: reqCtx?.spanId ?? null,
      correlation_id: reqCtx?.correlationId ?? null,
      parent_correlation_id: null,
      job_id: null,
      package_id: null,
      import_id: null,
      delivery_id: testEventId,
      provider: row.format,
      duration_ms: null,
      safe_counts: { events: 1 },
      attributes: { synthetic: true, probe: "siem_admin_test" },
      dropped_attributes: 0,
    });

    // Always force a fresh TLS handshake on explicit connectivity test so rotated certs/CA rules are verified live.
    pool.evict(row.publicId);

    let outcome: "completed" | "failed" | "unknown" = "failed";
    let reasonCode: string | null = null;
    let receiptConfirmation: SiemReceiptConfirmation = "none";

    try {
      const secrets = await readDestinationSecrets(deps.settings, deps.crypto, row.publicId);
      const delivered = await deliverProjectedBatch({
        pool,
        dest: toTransportConfig(row, deps.config.deploymentProfile),
        secrets,
        events: [syntheticEvent],
        egress: getEgressPort(deps.services),
      });
      outcome = "completed";
      receiptConfirmation = delivered.receiptConfirmation;
    } catch (err) {
      const classified = classifySocketError(err, false);
      outcome = classified.uncertainAfterWrite ? "unknown" : "failed";
      reasonCode = classified.reasonCode;
      receiptConfirmation = "none";
    }

    const finishedAt = deps.clock.now();
    const durationMs = Math.max(0, Math.round(performance.now() - startPerfMs));

    await deps.db.transaction(async (tx) => {
      await tx
        .update(siemDestinations)
        .set({
          lastTestAt: finishedAt,
          lastTestOutcome: outcome,
          lastTestReason: reasonCode,
          updatedAt: finishedAt,
        })
        .where(eq(siemDestinations.id, row.id));

      await deps.audit.record(
        {
          category: "integration",
          eventName: "siem.destination.test",
          action: "test",
          outcome,
          severity: outcome === "completed" ? "INFO" : "WARN",
          reasonCode: reasonCode ?? undefined,
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "siem_destination", publicId: row.publicId },
          deliveryId: testEventId,
          durationMs,
          attributes: {
            format: row.format,
            receipt_confirmation: receiptConfirmation,
          },
          occurredAt: finishedAt,
        },
        tx,
      );
    });

    return {
      eventId: testEventId,
      attemptedAt: startedAt,
      outcome,
      reasonCode,
      receiptConfirmation,
      durationMs,
    };
  }

  async function listDeadLetters(
    principal: SessionPrincipal,
    rawInput: { destinationPublicId?: string; cursor?: string; limit?: number },
  ): Promise<{ items: SiemDeadLetterItem[]; nextCursor: string | null }> {
    await ensureAuthorized(principal, "siem.read");
    const input = listDeadLettersSchema.parse(rawInput);
    const limit = input.limit ?? 50;
    const parsedCursor = parseDeadLetterCursor(input.cursor);

    let destFilterId: number | undefined;
    if (input.destinationPublicId) {
      const [destRow] = await deps.db
        .select({ id: siemDestinations.id })
        .from(siemDestinations)
        .where(eq(siemDestinations.publicId, input.destinationPublicId))
        .limit(1);
      if (!destRow) throw notFound("DESTINATION_NOT_FOUND");
      destFilterId = destRow.id;
    }

    const conditions = [eq(siemOutbox.state, "dead_letter")];
    if (destFilterId !== undefined) conditions.push(eq(siemOutbox.destinationId, destFilterId));
    if (parsedCursor) conditions.push(lte(siemOutbox.id, parsedCursor.id - 1));

    const rows = await deps.db
      .select({
        outbox: siemOutbox,
        destPublicId: siemDestinations.publicId,
        destName: siemDestinations.name,
      })
      .from(siemOutbox)
      .innerJoin(siemDestinations, eq(siemOutbox.destinationId, siemDestinations.id))
      .where(and(...conditions))
      .orderBy(desc(siemOutbox.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && page.length > 0 ? `dl:${page[page.length - 1]!.outbox.id}` : null;

    return {
      items: page.map(({ outbox, destPublicId, destName }) => ({
        publicId: outbox.publicId,
        destinationPublicId: destPublicId,
        destinationName: destName,
        eventId: outbox.eventId,
        chainSeq: outbox.chainSeq,
        eventOccurredAt: outbox.eventOccurredAt,
        category: outbox.category as AuditCategory,
        severity: outbox.severity as Severity,
        eventName: outbox.eventName,
        attempts: outbox.attempts,
        maxAttempts: outbox.maxAttempts,
        lastReasonCode: outbox.lastReasonCode,
        deadLetteredAt: outbox.deadLetteredAt,
        createdAt: outbox.createdAt,
      })),
      nextCursor,
    };
  }

  async function replayDeadLetters(
    principal: SessionPrincipal,
    rawInput: { publicIds?: readonly string[]; destinationPublicId?: string; limit?: number },
  ): Promise<{ replayedCount: number }> {
    await ensureAuthorized(principal, "siem.manage");
    const input = replayDeadLettersSchema.parse(rawInput);
    const maxReplay = input.limit ?? 200;
    const now = deps.clock.now();
    const reqCtx = getRequestContext();

    let replayedCount = 0;
    await deps.db.transaction(async (tx) => {
      await assertActorCurrentInTx(deps, principal, "siem.manage", now, tx);

      let targetDestId: number | undefined;
      if (input.destinationPublicId) {
        const [dest] = await tx
          .select({ id: siemDestinations.id })
          .from(siemDestinations)
          .where(eq(siemDestinations.publicId, input.destinationPublicId))
          .for("update")
          .limit(1);
        if (!dest) throw notFound("DESTINATION_NOT_FOUND");
        targetDestId = dest.id;
      }

      const conditions = [eq(siemOutbox.state, "dead_letter")];
      if (targetDestId !== undefined) conditions.push(eq(siemOutbox.destinationId, targetDestId));
      if (input.publicIds && input.publicIds.length > 0) {
        conditions.push(inArray(siemOutbox.publicId, [...input.publicIds]));
      }

      const candidates = await tx
        .select({ id: siemOutbox.id, destinationId: siemOutbox.destinationId })
        .from(siemOutbox)
        .where(and(...conditions))
        .orderBy(asc(siemOutbox.id))
        .for("update")
        .limit(maxReplay);

      replayedCount = candidates.length;
      if (replayedCount > 0) {
        const ids = candidates.map((c) => c.id);
        const destIds = [...new Set(candidates.map((c) => c.destinationId))];

        await tx
          .update(siemOutbox)
          .set({
            state: "queued",
            attempts: 0,
            nextAttemptAt: now,
            deadLetteredAt: null,
            updatedAt: now,
          })
          .where(inArray(siemOutbox.id, ids));

        await tx
          .update(siemDestinations)
          .set({
            circuitState: "half_open",
            circuitOpenUntil: null,
            updatedAt: now,
          })
          .where(and(inArray(siemDestinations.id, destIds), eq(siemDestinations.circuitState, "open")));

        await deps.jobs.enqueue(
          "siem.deliver",
          { reason: "dead_letter_replay" },
          {
            idempotencyKey: `siem.replay:${now.getTime()}:${principal.sessionId}`,
            correlationId: reqCtx?.correlationId ?? reqCtx?.requestId,
          },
          tx,
        );
      }

      await deps.audit.record(
        {
          category: "admin",
          eventName: "siem.dead_letter.replayed",
          action: "transition",
          outcome: "completed",
          severity: "INFO",
          actor: { userId: principal.userId, role: principal.role },
          resource: input.destinationPublicId
            ? { type: "siem_destination", publicId: input.destinationPublicId }
            : { type: "siem_dead_letter_queue" },
          safeCounts: { replayed: replayedCount },
          occurredAt: now,
        },
        tx,
      );
    });

    return { replayedCount };
  }

  async function purgeDeadLetters(
    principal: SessionPrincipal,
    rawInput: { publicIds: readonly string[] },
  ): Promise<{ purgedCount: number }> {
    await ensureAuthorized(principal, "siem.manage");
    const input = purgeDeadLettersSchema.parse(rawInput);
    const now = deps.clock.now();

    let purgedCount = 0;
    await deps.db.transaction(async (tx) => {
      await assertActorCurrentInTx(deps, principal, "siem.manage", now, tx);

      const locked = await tx
        .select({ id: siemOutbox.id })
        .from(siemOutbox)
        .where(and(eq(siemOutbox.state, "dead_letter"), inArray(siemOutbox.publicId, [...input.publicIds])))
        .orderBy(asc(siemOutbox.id))
        .for("update");

      purgedCount = locked.length;

      // Rule 3: Write durable audit record BEFORE executing delete inside the same transaction.
      await deps.audit.record(
        {
          category: "security",
          eventName: "siem.dead_letter.purged",
          action: "delete",
          outcome: "completed",
          severity: "WARN",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "siem_dead_letter_queue" },
          safeCounts: { purged: purgedCount },
          occurredAt: now,
        },
        tx,
      );

      if (purgedCount > 0) {
        await tx.delete(siemOutbox).where(
          inArray(
            siemOutbox.id,
            locked.map((r) => r.id),
          ),
        );
      }
    });

    return { purgedCount };
  }

  async function acquireDestinationLease(
    destId: number,
    ownerId: string,
    fencingToken: number | undefined,
  ): Promise<SiemDestinationRow | null> {
    const now = deps.clock.now();
    const expiresAt = new Date(now.getTime() + LEASE_DURATION_MS);

    return deps.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(siemDestinations)
        .where(
          and(
            eq(siemDestinations.id, destId),
            eq(siemDestinations.enabled, true),
            or(
              isNull(siemDestinations.leaseOwnerJobId),
              eq(siemDestinations.leaseOwnerJobId, ownerId),
              lte(siemDestinations.leaseExpiresAt, now),
            ),
          ),
        )
        .for("update")
        .limit(1);

      if (!row) return null;
      if (fencingToken !== undefined && fencingToken < row.lastFencingToken) {
        return null;
      }

      const nextFence = fencingToken !== undefined ? Math.max(row.lastFencingToken, fencingToken) : row.lastFencingToken;
      await tx
        .update(siemDestinations)
        .set({
          leaseOwnerJobId: ownerId,
          leaseExpiresAt: expiresAt,
          lastFencingToken: nextFence,
        })
        .where(eq(siemDestinations.id, row.id));

      return { ...row, leaseOwnerJobId: ownerId, leaseExpiresAt: expiresAt, lastFencingToken: nextFence };
    });
  }

  async function releaseDestinationLease(destId: number, ownerId: string): Promise<void> {
    await deps.db
      .update(siemDestinations)
      .set({ leaseOwnerJobId: null, leaseExpiresAt: null })
      .where(and(eq(siemDestinations.id, destId), eq(siemDestinations.leaseOwnerJobId, ownerId)));
  }

  async function projectEventsForDestination(params: {
    dest: SiemDestinationRow;
    ownerId: string;
    job?: ClaimedJob<unknown>;
    batchSize: number;
    maxAttempts: number;
    spoolMaxEvents: number;
  }): Promise<number> {
    const { dest, ownerId, job, batchSize, maxAttempts, spoolMaxEvents } = params;
    const auditPort = getAuditPort(deps.services);
    if (!auditPort) return 0;

    let cursor = dest.auditCursor;
    let lastSeq = dest.lastProjectedSeq;
    let totalProjected = 0;

    for (let pageIdx = 0; pageIdx < 5; pageIdx += 1) {
      if (job?.signal.aborted) break;

      const [spoolRow] = await deps.db
        .select({ count: sql<number>`COUNT(*)` })
        .from(siemOutbox)
        .where(eq(siemOutbox.destinationId, dest.id));
      const activeSpool = Number(spoolRow?.count ?? 0);

      if (activeSpool >= spoolMaxEvents) {
        const nowMs = deps.clock.now().getTime();
        const prevAlert = lastSaturationAuditMs.get(dest.publicId) ?? 0;
        if (nowMs - prevAlert >= 10 * 60 * 1_000) {
          lastSaturationAuditMs.set(dest.publicId, nowMs);
          deps.audit.note({
            category: "system",
            eventName: "siem.spool.saturated",
            action: "observe",
            outcome: "refused",
            severity: "ERROR",
            reasonCode: "SPOOL_LIMIT_REACHED",
            actor: { role: "system" },
            resource: { type: "siem_destination", publicId: dest.publicId },
            safeCounts: { active_spool: activeSpool, spool_max: spoolMaxEvents },
            occurredAt: new Date(nowMs),
          });
        }
        break;
      }

      const readBudget = Math.min(Math.max(batchSize * 2, 100), 500, spoolMaxEvents - activeSpool);
      const batch = await auditPort.readEventsAfter(cursor, readBudget);
      if (batch.events.length === 0) {
        break;
      }

      const now = deps.clock.now();
      const toInsert: (typeof siemOutbox.$inferInsert)[] = [];
      for (const rawEvent of batch.events) {
        if (typeof rawEvent.chain_seq === "number" && rawEvent.chain_seq > lastSeq) {
          lastSeq = rawEvent.chain_seq;
        }
        const projected = auditPort.projectForExternal
          ? sanitizeProjectedEvent(auditPort.projectForExternal(rawEvent))
          : sanitizeProjectedEvent(rawEvent);

        if (isSiemOperationalSelfEvent(projected.event_name)) continue;
        if (
          !matchesDestinationFilter(projected, {
            minSeverity: dest.minSeverity as Severity,
            categories: dest.categoriesJson,
          })
        ) {
          continue;
        }

        const occurredDate = new Date(projected.occurred_at);
        toInsert.push({
          publicId: ulid(now.getTime()),
          destinationId: dest.id,
          destinationVersion: dest.version,
          eventId: projected.event_id,
          chainSeq: projected.chain_seq,
          eventOccurredAt: Number.isNaN(occurredDate.getTime()) ? now : occurredDate,
          category: projected.category,
          severity: projected.severity_text,
          eventName: projected.event_name,
          projectedJson: projected,
          state: "queued",
          attempts: 0,
          maxAttempts,
          nextAttemptAt: now,
          correlationId: projected.correlation_id ?? job?.correlationId ?? null,
          createdAt: now,
          updatedAt: now,
        });
      }

      const nextCursor = batch.nextCursor ?? cursor;
      const insertedInPage = await deps.db.transaction(async (tx) => {
        if (job) await job.assertStillOwned(tx);
        const [locked] = await tx
          .select({ id: siemDestinations.id, leaseOwnerJobId: siemDestinations.leaseOwnerJobId })
          .from(siemDestinations)
          .where(eq(siemDestinations.id, dest.id))
          .for("update")
          .limit(1);
        if (!locked || locked.leaseOwnerJobId !== ownerId) {
          throw conflict("LEASE_LOST", "Destination lease was claimed by another worker.");
        }

        if (toInsert.length > 0) {
          await tx
            .insert(siemOutbox)
            .values(toInsert)
            .onDuplicateKeyUpdate({ set: { updatedAt: now } });
        }

        await tx
          .update(siemDestinations)
          .set({
            auditCursor: nextCursor,
            lastProjectedSeq: lastSeq,
            updatedAt: now,
          })
          .where(eq(siemDestinations.id, dest.id));

        return toInsert.length;
      });

      totalProjected += insertedInPage;
      if (!batch.nextCursor || batch.nextCursor === cursor) break;
      cursor = batch.nextCursor;
    }

    return totalProjected;
  }

  async function transmitReadyBatchesForDestination(params: {
    destId: number;
    ownerId: string;
    job?: ClaimedJob<unknown>;
    batchSize: number;
    circuitThreshold: number;
    circuitCooldownSeconds: number;
  }): Promise<{ delivered: number; failed: number; deadLettered: number }> {
    const { destId, ownerId, job, batchSize, circuitThreshold, circuitCooldownSeconds } = params;
    let delivered = 0;
    let failed = 0;
    let deadLettered = 0;

    // Process up to 5 batches per cycle so large backlogs drain briskly while remaining bounded.
    for (let round = 0; round < 5; round += 1) {
      if (job?.signal.aborted) break;
      const now = deps.clock.now();

      const [dest] = await deps.db.select().from(siemDestinations).where(eq(siemDestinations.id, destId)).limit(1);
      if (!dest || !dest.enabled || dest.leaseOwnerJobId !== ownerId) break;

      let effectiveCircuit = dest.circuitState as SiemCircuitState;
      if (effectiveCircuit === "open") {
        if (dest.circuitOpenUntil && dest.circuitOpenUntil.getTime() > now.getTime()) {
          break;
        }
        effectiveCircuit = "half_open";
      }

      const limit = effectiveCircuit === "half_open" ? Math.min(10, batchSize) : batchSize;
      const readyRows: SiemOutboxRow[] = await deps.db
        .select()
        .from(siemOutbox)
        .where(
          and(
            eq(siemOutbox.destinationId, dest.id),
            eq(siemOutbox.state, "queued"),
            lte(siemOutbox.nextAttemptAt, now),
          ),
        )
        .orderBy(asc(siemOutbox.id))
        .limit(limit);

      if (readyRows.length === 0) break;

      let deliveryError: SiemTransportError | null = null;
      let receiptConfirmation: SiemReceiptConfirmation = "none";

      try {
        const secrets = await readDestinationSecrets(deps.settings, deps.crypto, dest.publicId);
        const res = await deliverProjectedBatch({
          pool,
          dest: toTransportConfig(dest, deps.config.deploymentProfile),
          secrets,
          events: readyRows.map((r) => r.projectedJson),
          egress: getEgressPort(deps.services),
          signal: job?.signal,
        });
        receiptConfirmation = res.receiptConfirmation;
      } catch (err) {
        deliveryError = classifySocketError(err, false);
      }

      const completedAt = deps.clock.now();

      if (!deliveryError) {
        const rowIds = readyRows.map((r) => r.id);
        await deps.db.transaction(async (tx) => {
          if (job) await job.assertStillOwned(tx);
          const [locked] = await tx
            .select({ id: siemDestinations.id, leaseOwnerJobId: siemDestinations.leaseOwnerJobId })
            .from(siemDestinations)
            .where(eq(siemDestinations.id, dest.id))
            .for("update")
            .limit(1);
          if (!locked || locked.leaseOwnerJobId !== ownerId) {
            throw conflict("LEASE_LOST", "Destination lease was claimed by another worker.");
          }

          await tx.delete(siemOutbox).where(inArray(siemOutbox.id, rowIds));
          await tx
            .update(siemDestinations)
            .set({
              circuitState: "closed",
              consecutiveFailures: 0,
              circuitOpenUntil: null,
              lastAttemptAt: completedAt,
              lastSuccessAt: completedAt,
              lastFailureReason: null,
              deliveredCount: sql`${siemDestinations.deliveredCount} + ${rowIds.length}`,
              receiptConfirmation,
              updatedAt: completedAt,
            })
            .where(eq(siemDestinations.id, dest.id));
        });
        delivered += rowIds.length;
        // If half-open probe succeeded, loop continues with full batchSize!
      } else {
        const reasonCode = deliveryError.reasonCode;
        const retryable = deliveryError.retryable;

        let batchDeadLetters = 0;
        await deps.db.transaction(async (tx) => {
          if (job) await job.assertStillOwned(tx);
          const [locked] = await tx
            .select()
            .from(siemDestinations)
            .where(eq(siemDestinations.id, dest.id))
            .for("update")
            .limit(1);
          if (!locked || locked.leaseOwnerJobId !== ownerId) {
            throw conflict("LEASE_LOST", "Destination lease was claimed by another worker.");
          }

          for (const item of readyRows) {
            const nextAttempts = item.attempts + 1;
            const exhaust = !retryable || nextAttempts >= item.maxAttempts;
            if (exhaust) {
              batchDeadLetters += 1;
              await tx
                .update(siemOutbox)
                .set({
                  state: "dead_letter",
                  attempts: nextAttempts,
                  lastAttemptAt: completedAt,
                  lastReasonCode: reasonCode,
                  deadLetteredAt: completedAt,
                  updatedAt: completedAt,
                })
                .where(eq(siemOutbox.id, item.id));
            } else {
              const delayMs = computeRetryBackoffMs(nextAttempts);
              await tx
                .update(siemOutbox)
                .set({
                  state: "queued",
                  attempts: nextAttempts,
                  lastAttemptAt: completedAt,
                  nextAttemptAt: new Date(completedAt.getTime() + delayMs),
                  lastReasonCode: reasonCode,
                  updatedAt: completedAt,
                })
                .where(eq(siemOutbox.id, item.id));
            }
          }

          const nextConsecutive = locked.consecutiveFailures + 1;
          const shouldOpenCircuit = effectiveCircuit === "half_open" || nextConsecutive >= circuitThreshold;
          const openUntil = shouldOpenCircuit
            ? new Date(completedAt.getTime() + circuitCooldownSeconds * 1_000)
            : null;
          const wasClosed = locked.circuitState !== "open";

          await tx
            .update(siemDestinations)
            .set({
              circuitState: shouldOpenCircuit ? "open" : "closed",
              consecutiveFailures: nextConsecutive,
              circuitOpenUntil: openUntil,
              lastAttemptAt: completedAt,
              lastFailureAt: completedAt,
              lastFailureReason: reasonCode,
              failedAttemptCount: sql`${siemDestinations.failedAttemptCount} + 1`,
              deadLetteredCount: sql`${siemDestinations.deadLetteredCount} + ${batchDeadLetters}`,
              updatedAt: completedAt,
            })
            .where(eq(siemDestinations.id, dest.id));

          if (batchDeadLetters > 0) {
            await deps.audit.record(
              {
                category: "system",
                eventName: "siem.delivery.dead_lettered",
                action: "transition",
                outcome: "failed",
                severity: "ERROR",
                reasonCode,
                actor: { role: "system" },
                resource: { type: "siem_destination", publicId: locked.publicId },
                safeCounts: { dead_lettered: batchDeadLetters },
                occurredAt: completedAt,
              },
              tx,
            );
          }

          if (shouldOpenCircuit && wasClosed) {
            await deps.audit.record(
              {
                category: "system",
                eventName: "siem.delivery.circuit_opened",
                action: "transition",
                outcome: "failed",
                severity: "WARN",
                reasonCode,
                actor: { role: "system" },
                resource: { type: "siem_destination", publicId: locked.publicId },
                safeCounts: { consecutive_failures: nextConsecutive },
                occurredAt: completedAt,
              },
              tx,
            );
          }
        });

        failed += readyRows.length;
        deadLettered += batchDeadLetters;
        // Stop retrying this destination in the same tick; backoff/circuit schedules the next attempt.
        break;
      }
    }

    return { delivered, failed, deadLettered };
  }

  async function runDeliveryCycle(options?: {
    job?: ClaimedJob<unknown>;
    destinationPublicId?: string;
  }): Promise<SiemDeliveryCycleResult> {
    const job = options?.job;
    const jobsAdmin = getJobsAdminPort(deps.services);
    if (jobsAdmin?.isDraining) {
      const draining = await jobsAdmin.isDraining();
      if (draining) {
        return { projected: 0, delivered: 0, failed: 0, deadLettered: 0 };
      }
    }

    // Read all operational settings BEFORE opening any transaction.
    const [batchSize, maxAttempts, spoolMaxEvents, circuitThreshold, circuitCooldownSeconds] = await Promise.all([
      deps.settings.get(SIEM_BATCH_SIZE.key, (r) => SIEM_BATCH_SIZE.schema.parse(r), SIEM_BATCH_SIZE.default),
      deps.settings.get(SIEM_MAX_ATTEMPTS.key, (r) => SIEM_MAX_ATTEMPTS.schema.parse(r), SIEM_MAX_ATTEMPTS.default),
      deps.settings.get(
        SIEM_SPOOL_MAX_EVENTS.key,
        (r) => SIEM_SPOOL_MAX_EVENTS.schema.parse(r),
        SIEM_SPOOL_MAX_EVENTS.default,
      ),
      deps.settings.get(
        SIEM_CIRCUIT_THRESHOLD.key,
        (r) => SIEM_CIRCUIT_THRESHOLD.schema.parse(r),
        SIEM_CIRCUIT_THRESHOLD.default,
      ),
      deps.settings.get(
        SIEM_CIRCUIT_COOLDOWN_SECONDS.key,
        (r) => SIEM_CIRCUIT_COOLDOWN_SECONDS.schema.parse(r),
        SIEM_CIRCUIT_COOLDOWN_SECONDS.default,
      ),
    ]);

    const conditions = [eq(siemDestinations.enabled, true)];
    if (options?.destinationPublicId) {
      conditions.push(eq(siemDestinations.publicId, options.destinationPublicId));
    }
    const candidates = await deps.db
      .select({ id: siemDestinations.id })
      .from(siemDestinations)
      .where(and(...conditions))
      .orderBy(asc(siemDestinations.id));

    const ownerId = job?.jobId ?? `direct_${ulid(deps.clock.now().getTime())}`;
    let projected = 0;
    let delivered = 0;
    let failed = 0;
    let deadLettered = 0;

    for (const candidate of candidates) {
      if (job?.signal.aborted) break;
      const leased = await acquireDestinationLease(candidate.id, ownerId, job?.fencingToken);
      if (!leased) continue;

      try {
        projected += await projectEventsForDestination({
          dest: leased,
          ownerId,
          job,
          batchSize,
          maxAttempts,
          spoolMaxEvents,
        });

        const txResult = await transmitReadyBatchesForDestination({
          destId: leased.id,
          ownerId,
          job,
          batchSize,
          circuitThreshold,
          circuitCooldownSeconds,
        });
        delivered += txResult.delivered;
        failed += txResult.failed;
        deadLettered += txResult.deadLettered;
      } finally {
        await releaseDestinationLease(leased.id, ownerId).catch(() => {});
      }
    }

    return { projected, delivered, failed, deadLettered };
  }

  async function health(): Promise<ModuleHealth[]> {
    const checkedAt = deps.clock.now();
    const [oldestAlertSeconds, spoolMaxEvents, rows, headSeq] = await Promise.all([
      deps.settings.get(
        SIEM_OLDEST_ALERT_SECONDS.key,
        (r) => SIEM_OLDEST_ALERT_SECONDS.schema.parse(r),
        SIEM_OLDEST_ALERT_SECONDS.default,
      ),
      deps.settings.get(
        SIEM_SPOOL_MAX_EVENTS.key,
        (r) => SIEM_SPOOL_MAX_EVENTS.schema.parse(r),
        SIEM_SPOOL_MAX_EVENTS.default,
      ),
      deps.db.select().from(siemDestinations),
      currentAuditHeadSeq(),
    ]);

    if (rows.length === 0) {
      return [
        {
          component: "siem.delivery",
          state: "not_configured",
          summary: "No SIEM or syslog forwarding destinations are configured.",
          metrics: {
            configuredDestinations: 0,
            enabledDestinations: 0,
            queueDepth: 0,
            deadLetters: 0,
            oldestPendingAgeSeconds: 0,
            maxLagSeq: 0,
          },
          checkedAt,
        },
      ];
    }

    const statsMap = await loadOutboxStatsByDestination(rows.map((r) => r.id));
    const enabledRows = rows.filter((r) => r.enabled);

    let totalQueued = 0;
    let totalDeadLetters = 0;
    let oldestPendingAgeSeconds = 0;
    let maxLagSeq = 0;

    for (const row of rows) {
      const s = statsMap.get(row.id);
      totalQueued += s?.queuedCount ?? 0;
      totalDeadLetters += s?.deadLetterCount ?? 0;
      if (row.enabled && s?.oldestQueuedCreatedAt) {
        const age = Math.max(0, Math.floor((checkedAt.getTime() - s.oldestQueuedCreatedAt.getTime()) / 1_000));
        if (age > oldestPendingAgeSeconds) oldestPendingAgeSeconds = age;
      }
      if (row.enabled) {
        const lag = Math.max(0, headSeq - row.lastProjectedSeq);
        if (lag > maxLagSeq) maxLagSeq = lag;
      }
    }

    const metrics = {
      configuredDestinations: rows.length,
      enabledDestinations: enabledRows.length,
      queueDepth: totalQueued,
      deadLetters: totalDeadLetters,
      oldestPendingAgeSeconds,
      maxLagSeq,
    };

    if (enabledRows.length === 0) {
      return [
        {
          component: "siem.delivery",
          state: "disabled",
          summary: "SIEM destinations are configured, and all forwarding is currently disabled.",
          metrics,
          checkedAt,
        },
      ];
    }

    let state: HealthState = "ok";
    let summary = "SIEM forwarding is active and healthy across enabled destinations.";

    const hasExpiredCert = enabledRows.some((r) => {
      const caExp = r.caCertExpiresAt ? r.caCertExpiresAt.getTime() <= checkedAt.getTime() : false;
      const cliExp = r.clientCertExpiresAt ? r.clientCertExpiresAt.getTime() <= checkedAt.getTime() : false;
      return caExp || cliExp;
    });
    const hasOpenCircuit = enabledRows.some((r) => r.circuitState === "open");
    const hasSpoolSaturation = enabledRows.some((r) => {
      const s = statsMap.get(r.id);
      return (s?.queuedCount ?? 0) + (s?.deadLetterCount ?? 0) >= spoolMaxEvents;
    });
    const hasSecretError = enabledRows.some((r) => r.lastFailureReason === "SECRET_UNREADABLE");

    if (totalDeadLetters > 0 || hasOpenCircuit || hasExpiredCert || hasSpoolSaturation || hasSecretError) {
      state = "failing";
      if (hasExpiredCert) {
        summary = "One or more enabled SIEM destinations have an expired TLS certificate.";
      } else if (hasSpoolSaturation) {
        summary = "A SIEM destination spool reached capacity; cursor projection is paused without dropping events.";
      } else if (hasOpenCircuit) {
        summary = "One or more SIEM destination circuit breakers are open after repeated transport failures.";
      } else if (totalDeadLetters > 0) {
        summary = "Dead-lettered SIEM events require administrator inspection or replay.";
      } else {
        summary = "Stored SIEM TLS credentials could not be read.";
      }
    } else {
      const hasExpiringSoonCert = enabledRows.some((r) => {
        const caSoon = r.caCertExpiresAt
          ? r.caCertExpiresAt.getTime() - checkedAt.getTime() <= CERT_EXPIRY_WARN_MS
          : false;
        const cliSoon = r.clientCertExpiresAt
          ? r.clientCertExpiresAt.getTime() - checkedAt.getTime() <= CERT_EXPIRY_WARN_MS
          : false;
        return caSoon || cliSoon;
      });
      const hasHalfOpen = enabledRows.some((r) => r.circuitState === "half_open" || r.consecutiveFailures > 0);
      const hasOldBacklog = oldestPendingAgeSeconds >= oldestAlertSeconds;

      if (hasExpiringSoonCert || hasHalfOpen || hasOldBacklog) {
        state = "degraded";
        if (hasOldBacklog) {
          summary = "Pending SIEM events exceed the configured delivery age threshold.";
        } else if (hasExpiringSoonCert) {
          summary = "A configured SIEM TLS certificate expires within 14 days.";
        } else {
          summary = "One or more SIEM destinations are retrying recent transport errors.";
        }
      }
    }

    return [{ component: "siem.delivery", state, summary, metrics, checkedAt }];
  }

  // Register recurring worker handler and schedule at composition time.
  deps.jobs.register<{ destinationPublicId?: string; reason?: string }>(
    "siem.deliver",
    async (job): Promise<JobResult> => {
      try {
        const res = await runDeliveryCycle({
          job,
          destinationPublicId: job.payload?.destinationPublicId,
        });
        return {
          outcome: "completed",
          safeCounts: {
            projected: res.projected,
            delivered: res.delivered,
            failed: res.failed,
            dead_lettered: res.deadLettered,
          },
        };
      } catch (err) {
        if (err instanceof DomainError && err.reasonCode === "LEASE_LOST") {
          return { outcome: "canceled", reasonCode: "LEASE_LOST" };
        }
        return { outcome: "failed", reasonCode: "SIEM_WORKER_ERROR", retryable: true };
      }
    },
    { retrySafe: true },
  );

  deps.jobs.registerSchedule({
    name: "siem.deliver.tick",
    type: "siem.deliver",
    everyMs: 10_000,
    payload: {},
  });

  return {
    listDestinations,
    getDestination,
    createDestination,
    updateDestination,
    setDestinationEnabled,
    deleteDestination,
    sendTestEvent,
    listDeadLetters,
    replayDeadLetters,
    purgeDeadLetters,
    runDeliveryCycle,
    health,
    async close() {
      await pool.closeAll();
    },
  };
}
