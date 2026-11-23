/**
 * Siem module — public service surface and factory. Owner: siem module engineer.
 * Other modules import TYPES from here and reach the instance through `deps.services.siem` at call time.
 */
import { performance } from "node:perf_hooks";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
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
import {
  isSiemOperationalSelfEvent,
  matchesDestinationFilter,
  projectAuditEnvelopeForSiem,
  sanitizeProjectedEvent,
} from "./projection.js";
import { siemDestinations, siemOutbox, type SiemDestinationRow, type SiemOutboxRow } from "./schema.js";
import {
  SIEM_BATCH_SIZE,
  SIEM_CIRCUIT_COOLDOWN_SECONDS,
  SIEM_CIRCUIT_THRESHOLD,
  SIEM_MAX_ATTEMPTS,
  SIEM_OLDEST_ALERT_SECONDS,
  SIEM_SPOOL_MAX_EVENTS,
  computeEndpointKey,
  parseCaBundleAndExpiry,
  readDestinationSecretsFromRow,
  sealDestinationSecrets,
  type ResolvedDestinationSecrets,
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
  testDestinationSchema,
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
export {
  EXTERNAL_BOOLEAN_ATTRIBUTE_KEYS,
  EXTERNAL_ENUM_VOCABULARIES,
  EXTERNAL_HEX_DIGEST_ATTRIBUTE_KEYS,
  EXTERNAL_NUMERIC_ATTRIBUTE_KEYS,
  EXTERNAL_SAFE_COUNT_KEYS,
  EXTERNAL_STRING_ATTRIBUTE_KEYS,
  isSiemOperationalSelfEvent,
  matchesDestinationFilter,
  projectAuditEnvelopeForSiem,
  sanitizeProjectedEvent,
} from "./projection.js";
export {
  findSiemCatalogueEntry,
  SIEM_EVENT_CATALOGUE,
  SIEM_NEVER_FORWARDED_ATTRIBUTE_KEYS,
  type SiemCatalogueEntry,
} from "./catalogue.js";

const CERT_EXPIRY_WARN_MS = 14 * 24 * 60 * 60 * 1_000;
const LEASE_DURATION_SECONDS = 60;

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

interface DestinationLease {
  row: SiemDestinationRow;
  token: string;
  fence: number;
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

/**
 * Extracts numeric `chain_seq` from an audit forwarder cursor (`s1:<seq>` base64url or `seq:<seq>`)
 * so progress-only retention-pruned pages keep `lastProjectedSeq` accurate.
 */
function extractSeqFromAuditCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  const plainMatch = /^seq:(\d{1,15})$/.exec(cursor);
  if (plainMatch) return Number(plainMatch[1]);
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const b64Match = /^s1:(\d{1,15})$/.exec(decoded);
    if (b64Match) return Number(b64Match[1]);
  } catch {
    // Opaque cursor format — ignore without throwing.
  }
  return null;
}

export function createSiemModule(deps: ModuleDeps): SiemModule {
  const pool = new SiemTlsConnectionPool();
  const lastSaturationAuditMs = new Map<string, number>();
  const activeTestProbes = new Set<string>();

  async function recordDenialAndThrow(principal: SessionPrincipal | null | undefined, capability: Capability): Promise<never> {
    const now = deps.clock.now();
    try {
      assertPrincipalSnapshot(principal, capability, now);
    } catch (err) {
      if (
        err instanceof DomainError &&
        (err.code === "UNAUTHENTICATED" || err.code === "FORBIDDEN" || err.code === "REMEDIATION_REQUIRED")
      ) {
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

  async function currentAuditHeadSeq(referenceCursor?: string | null): Promise<number> {
    const auditPort = getAuditPort(deps.services);
    if (!auditPort) return 0;
    try {
      // Probe from a known advanced cursor when available so retention-pruned early pages are not rescanned.
      const res = await auditPort.readEventsAfter(referenceCursor ?? null, 1);
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
        uncertainCount: row.uncertainCount,
        prunedAuditCount: row.prunedAuditCount,
        missingAuditGapCount: row.missingAuditGapCount,
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
    const hasCertPatch =
      secrets.clientCertPem !== undefined && secrets.clientCertPem !== null && secrets.clientCertPem.trim() !== "";
    const hasKeyPatch =
      secrets.clientKeyPem !== undefined && secrets.clientKeyPem !== null && secrets.clientKeyPem.trim() !== "";
    if (hasCertPatch && hasKeyPatch) {
      validateClientCertAndKeyPair(secrets.clientCertPem!, secrets.clientKeyPem!);
    }
    if (secrets.authSecret && secrets.authSecret.trim() !== "") {
      validateAuthSecretValue(secrets.authSecret);
    }
  }

  function highestKnownCursor(rows: readonly SiemDestinationRow[]): string | null {
    let best: SiemDestinationRow | null = null;
    for (const r of rows) {
      if (r.auditCursor && (!best || r.lastProjectedSeq > best.lastProjectedSeq)) {
        best = r;
      }
    }
    return best?.auditCursor ?? null;
  }

  async function listDestinations(principal: SessionPrincipal): Promise<SiemDestinationSummary[]> {
    await ensureAuthorized(principal, "siem.read");
    const now = deps.clock.now();
    const rows = await deps.db.select().from(siemDestinations).orderBy(asc(siemDestinations.name), asc(siemDestinations.id));
    const [statsMap, headSeq] = await Promise.all([
      loadOutboxStatsByDestination(rows.map((r) => r.id)),
      currentAuditHeadSeq(highestKnownCursor(rows)),
    ]);
    return rows.map((row) => mapDestinationSummary(row, statsMap.get(row.id), headSeq, now));
  }

  async function getDestination(principal: SessionPrincipal, rawPublicId: string): Promise<SiemDestinationSummary> {
    await ensureAuthorized(principal, "siem.read");
    const { publicId } = destinationPublicIdSchema.parse({ publicId: rawPublicId });
    const now = deps.clock.now();
    const [row] = await deps.db.select().from(siemDestinations).where(eq(siemDestinations.publicId, publicId)).limit(1);
    if (!row) throw notFound("DESTINATION_NOT_FOUND");
    const [statsMap, headSeq] = await Promise.all([
      loadOutboxStatsByDestination([row.id]),
      currentAuditHeadSeq(row.auditCursor),
    ]);
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
    // Fail closed immediately if centralized egress service is absent; run full DNS/egress preflight when enabled.
    if (enabled || !getEgressPort(deps.services)) {
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
    const endpointKey = computeEndpointKey({ format: input.format, host, port, otlpPath });

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

      const sealed = sealDestinationSecrets({
        crypto: deps.crypto,
        publicId,
        targetVersion: 1,
        targetEndpointKey: endpointKey,
        patch: input.secrets ?? {},
      });
      const validatedTls = sealed.material;
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
        endpointGeneration: 1,
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
        caEnc: sealed.columns.caEnc,
        clientCertEnc: sealed.columns.clientCertEnc,
        clientKeyEnc: sealed.columns.clientKeyEnc,
        authSecretEnc: sealed.columns.authSecretEnc,
        hasCustomCa: validatedTls.customCaPem !== null,
        hasClientCert: validatedTls.clientCertPem !== null,
        hasClientKey: validatedTls.clientKeyPem !== null,
        hasAuthSecret: validatedTls.authSecret !== null,
        caCertExpiresAt: validatedTls.caCertExpiresAt,
        clientCertExpiresAt: validatedTls.clientCertExpiresAt,
        secretUpdatedAt: anySecretSaved ? now : null,
        lastCursorProgressAt: enabled ? now : null,
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

    const [snapshot] = await deps.db
      .select()
      .from(siemDestinations)
      .where(eq(siemDestinations.publicId, input.publicId))
      .limit(1);
    if (!snapshot) throw notFound("DESTINATION_NOT_FOUND");

    const previewFormat = (input.format ?? snapshot.format) as SiemFormat;
    const previewHost = input.host !== undefined ? normalizeAndValidateHost(input.host) : snapshot.host;
    const previewPort = input.port ?? snapshot.port;
    const previewOtlpPath =
      input.otlpPath !== undefined || input.format !== undefined
        ? normalizeOtlpPath(input.otlpPath !== undefined ? input.otlpPath : snapshot.otlpPath, previewFormat)
        : snapshot.otlpPath;
    const previewAuthHeader =
      input.authHeaderName !== undefined || input.format !== undefined
        ? normalizeAuthHeaderName(
            input.authHeaderName !== undefined ? input.authHeaderName : snapshot.authHeaderName,
            previewFormat,
          )
        : snapshot.authHeaderName;
    const previewEnabled = input.enabled ?? snapshot.enabled;
    const previewAllowPrivate = input.allowPrivateNetwork ?? snapshot.allowPrivateNetwork;

    if (previewEnabled) {
      await preflightEgressOrThrow({
        publicId: snapshot.publicId,
        version: snapshot.version + 1,
        format: previewFormat,
        host: previewHost,
        port: previewPort,
        otlpPath: previewOtlpPath,
        allowPrivateNetwork: previewAllowPrivate,
        facility: input.facility ?? snapshot.facility,
        appName: input.appName ?? snapshot.appName,
        hostnameOverride:
          input.hostnameOverride === undefined
            ? snapshot.hostnameOverride
            : input.hostnameOverride && input.hostnameOverride.trim().length > 0
              ? input.hostnameOverride.trim()
              : null,
        enterpriseNumber: input.enterpriseNumber === undefined ? snapshot.enterpriseNumber : input.enterpriseNumber,
        sdIdName: input.sdIdName ?? snapshot.sdIdName,
        includeBom: input.includeBom ?? snapshot.includeBom,
        maxMessageBytes: input.maxMessageBytes ?? snapshot.maxMessageBytes,
        connectTimeoutMs: input.connectTimeoutMs ?? snapshot.connectTimeoutMs,
        writeTimeoutMs: input.writeTimeoutMs ?? snapshot.writeTimeoutMs,
        authHeaderName: previewAuthHeader,
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

      const nextFormat = (input.format ?? locked.format) as SiemFormat;
      const nextHost = input.host !== undefined ? normalizeAndValidateHost(input.host) : locked.host;
      const nextPort = input.port ?? locked.port;
      const nextOtlpPath =
        input.otlpPath !== undefined || input.format !== undefined
          ? normalizeOtlpPath(input.otlpPath !== undefined ? input.otlpPath : locked.otlpPath, nextFormat)
          : locked.otlpPath;
      const nextAuthHeader =
        input.authHeaderName !== undefined || input.format !== undefined
          ? normalizeAuthHeaderName(
              input.authHeaderName !== undefined ? input.authHeaderName : locked.authHeaderName,
              nextFormat,
            )
          : locked.authHeaderName;
      const nextEnabled = input.enabled ?? locked.enabled;
      const nextAllowPrivate = input.allowPrivateNetwork ?? locked.allowPrivateNetwork;
      const nextFacility = input.facility ?? locked.facility;
      const nextAppName = input.appName ?? locked.appName;
      const nextHostnameOverride =
        input.hostnameOverride === undefined
          ? locked.hostnameOverride
          : input.hostnameOverride && input.hostnameOverride.trim().length > 0
            ? input.hostnameOverride.trim()
            : null;
      const nextEnterpriseNumber =
        input.enterpriseNumber === undefined ? locked.enterpriseNumber : input.enterpriseNumber;
      const nextSdIdName = input.sdIdName ?? locked.sdIdName;
      const nextIncludeBom = input.includeBom ?? locked.includeBom;
      const nextMaxBytes = input.maxMessageBytes ?? locked.maxMessageBytes;
      const nextConnectTimeout = input.connectTimeoutMs ?? locked.connectTimeoutMs;
      const nextWriteTimeout = input.writeTimeoutMs ?? locked.writeTimeoutMs;
      const nextMinSeverity = input.minSeverity ?? (locked.minSeverity as Severity);
      const nextCategories = input.categories ? [...new Set(input.categories)] : [...locked.categoriesJson];

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

      const oldEndpointKey = computeEndpointKey(locked);
      const nextEndpointKey = computeEndpointKey({
        format: nextFormat,
        host: nextHost,
        port: nextPort,
        otlpPath: nextOtlpPath,
      });
      const endpointChanged = nextEndpointKey !== oldEndpointKey;

      // Security invariant: changing host/port/format/path must NEVER silently forward existing
      // mTLS private keys or collector auth tokens to a different endpoint.
      if (endpointChanged) {
        if (locked.hasClientKey && input.secrets?.clientKeyPem === undefined) {
          throw validation(
            "CREDENTIALS_REQUIRE_ROTATION_OR_CLEAR",
            "Changing the receiver endpoint requires rotating or clearing stored mTLS client credentials.",
          );
        }
        if (locked.hasAuthSecret && input.secrets?.authSecret === undefined) {
          throw validation(
            "CREDENTIALS_REQUIRE_ROTATION_OR_CLEAR",
            "Changing the receiver endpoint requires rotating or clearing the stored authentication secret.",
          );
        }
      }

      const nextVersion = locked.version + 1;
      const nextEndpointGen = endpointChanged ? locked.endpointGeneration + 1 : locked.endpointGeneration;

      const sealed = sealDestinationSecrets({
        crypto: deps.crypto,
        publicId: locked.publicId,
        targetVersion: nextVersion,
        targetEndpointKey: nextEndpointKey,
        patch: input.secrets,
        existingRow: locked,
      });
      const validatedTls = sealed.material;

      let migratedBacklogCount = 0;
      let quarantinedBacklogCount = 0;
      let filteredQueuedCount = 0;

      const scopeChanged =
        nextMinSeverity !== locked.minSeverity ||
        nextCategories.length !== locked.categoriesJson.length ||
        nextCategories.some((c, idx) => c !== locked.categoriesJson[idx]);

      if (endpointChanged || scopeChanged) {
        const queuedItems = await tx
          .select({ id: siemOutbox.id, projectedJson: siemOutbox.projectedJson })
          .from(siemOutbox)
          .where(and(eq(siemOutbox.destinationId, locked.id), eq(siemOutbox.state, "queued")))
          .for("update");

        if (queuedItems.length > 0) {
          if (endpointChanged && input.migrateBacklog !== true) {
            const ids = queuedItems.map((q) => q.id);
            quarantinedBacklogCount = ids.length;
            await tx
              .update(siemOutbox)
              .set({
                state: "dead_letter",
                lastReasonCode: "ENDPOINT_CHANGED",
                deadLetteredAt: now,
                updatedAt: now,
              })
              .where(inArray(siemOutbox.id, ids));
          } else {
            const matchingIds: number[] = [];
            const filteredOutIds: number[] = [];
            for (const q of queuedItems) {
              if (
                matchesDestinationFilter(q.projectedJson, {
                  minSeverity: nextMinSeverity as Severity,
                  categories: nextCategories,
                })
              ) {
                matchingIds.push(q.id);
              } else {
                filteredOutIds.push(q.id);
              }
            }

            if (filteredOutIds.length > 0) {
              filteredQueuedCount = filteredOutIds.length;
              await tx.delete(siemOutbox).where(inArray(siemOutbox.id, filteredOutIds));
            }
            if (matchingIds.length > 0) {
              if (endpointChanged) migratedBacklogCount = matchingIds.length;
              await tx
                .update(siemOutbox)
                .set({
                  destinationVersion: nextVersion,
                  endpointGeneration: nextEndpointGen,
                  updatedAt: now,
                })
                .where(inArray(siemOutbox.id, matchingIds));
            }
          }
        }
      }

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
          endpointGeneration: nextEndpointGen,
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
          caEnc: sealed.columns.caEnc,
          clientCertEnc: sealed.columns.clientCertEnc,
          clientKeyEnc: sealed.columns.clientKeyEnc,
          authSecretEnc: sealed.columns.authSecretEnc,
          hasCustomCa: validatedTls.customCaPem !== null,
          hasClientCert: validatedTls.clientCertPem !== null,
          hasClientKey: validatedTls.clientKeyPem !== null,
          hasAuthSecret: validatedTls.authSecret !== null,
          caCertExpiresAt: validatedTls.caCertExpiresAt,
          clientCertExpiresAt: validatedTls.clientCertExpiresAt,
          secretUpdatedAt: input.secrets !== undefined ? now : locked.secretUpdatedAt,
          lastCursorProgressAt:
            nextEnabled && !locked.enabled ? now : locked.lastCursorProgressAt,
          deadLetteredCount: sql`${siemDestinations.deadLetteredCount} + ${quarantinedBacklogCount}`,
          circuitState: locked.circuitState === "open" ? "half_open" : locked.circuitState,
          circuitOpenUntil: locked.circuitState === "open" ? null : locked.circuitOpenUntil,
          // Invalidate any in-flight worker lease on ANY configuration revision bump so stale snapshots cut off cleanly.
          leaseOwnerJobId: null,
          leaseExpiresAt: null,
          version: nextVersion,
          updatedAt: now,
        })
        .where(eq(siemDestinations.id, locked.id));

      await deps.audit.record(
        {
          category: endpointChanged ? "security" : "admin",
          eventName: "siem.destination.updated",
          action: "update",
          outcome: "completed",
          severity: endpointChanged ? "WARN" : "INFO",
          actor: { userId: principal.userId, role: principal.role },
          resource: { type: "siem_destination", publicId: locked.publicId },
          attributes: {
            format: nextFormat,
            port: nextPort,
            enabled: nextEnabled,
            allow_private_network: nextAllowPrivate,
            min_severity: nextMinSeverity,
            endpoint_changed: endpointChanged,
            secrets_modified: input.secrets !== undefined,
            has_custom_ca: validatedTls.customCaPem !== null,
            has_mtls: validatedTls.clientCertPem !== null,
            version: nextVersion,
          },
          safeCounts: {
            categories: nextCategories.length,
            backlog_migrated: migratedBacklogCount,
            backlog_quarantined: quarantinedBacklogCount,
            filtered_queued: filteredQueuedCount,
          },
          occurredAt: now,
        },
        tx,
      );

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
      const endpointKey = computeEndpointKey(locked);
      const resealed = sealDestinationSecrets({
        crypto: deps.crypto,
        publicId: locked.publicId,
        targetVersion: nextVersion,
        targetEndpointKey: endpointKey,
        patch: undefined,
        existingRow: locked,
      });

      await tx
        .update(siemDestinations)
        .set({
          enabled: input.enabled,
          caEnc: resealed.columns.caEnc,
          clientCertEnc: resealed.columns.clientCertEnc,
          clientKeyEnc: resealed.columns.clientKeyEnc,
          authSecretEnc: resealed.columns.authSecretEnc,
          lastCursorProgressAt:
            input.enabled && !locked.enabled ? now : locked.lastCursorProgressAt,
          circuitState: input.enabled && locked.circuitState === "open" ? "half_open" : locked.circuitState,
          circuitOpenUntil: input.enabled && locked.circuitState === "open" ? null : locked.circuitOpenUntil,
          leaseOwnerJobId: null,
          leaseExpiresAt: null,
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

      await tx.delete(siemOutbox).where(eq(siemOutbox.destinationId, locked.id));
      await tx.delete(siemDestinations).where(eq(siemDestinations.id, locked.id));
    });

    pool.evict(input.publicId);
  }

  /**
   * Step-up connectivity probe (`siem.manage`):
   * - Re-validates the actor inside a DB transaction BEFORE decrypting credentials or dialing.
   * - Binds to a single consistent `(row, secrets)` revision snapshot (`expectedVersion` enforced if supplied).
   * - Uses an isolated one-shot TLS connection pool so live worker sockets are never evicted or shared.
   */
  async function sendTestEvent(
    principal: SessionPrincipal,
    rawInput: { publicId: string; expectedVersion?: number },
  ): Promise<SiemTestResult> {
    await ensureAuthorized(principal, "siem.manage");
    const input = testDestinationSchema.parse(rawInput);

    if (activeTestProbes.has(input.publicId)) {
      throw conflict("TEST_ALREADY_IN_PROGRESS", "A connectivity test is already running for this destination.");
    }
    activeTestProbes.add(input.publicId);

    const probePool = new SiemTlsConnectionPool();
    try {
      const startedAt = deps.clock.now();
      const startPerfMs = performance.now();
      const testEventId = ulid(startedAt.getTime());
      const reqCtx = getRequestContext();

      // Atomically verify actor step-up, read consistent row + secrets, and record durable `attempted` audit BEFORE network I/O.
      const { row, secrets } = await deps.db.transaction(async (tx) => {
        await assertActorCurrentInTx(deps, principal, "siem.manage", startedAt, tx);

        const [found] = await tx
          .select()
          .from(siemDestinations)
          .where(eq(siemDestinations.publicId, input.publicId))
          .limit(1);
        if (!found) throw notFound("DESTINATION_NOT_FOUND");
        if (input.expectedVersion !== undefined && found.version !== input.expectedVersion) {
          throw conflict("VERSION_MISMATCH", "This destination was modified by another session. Reload and try again.");
        }

        const resolvedSecrets: ResolvedDestinationSecrets = await readDestinationSecretsFromRow(
          found,
          deps.settings,
          deps.crypto,
          tx,
        );

        await deps.audit.record(
          {
            category: "integration",
            eventName: "siem.destination.test",
            action: "test",
            outcome: "attempted",
            severity: "INFO",
            actor: { userId: principal.userId, role: principal.role },
            resource: { type: "siem_destination", publicId: found.publicId },
            deliveryId: testEventId,
            attributes: { format: found.format, version: found.version },
            occurredAt: startedAt,
          },
          tx,
        );

        return { row: found, secrets: resolvedSecrets };
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
        actor_ref: deps.crypto.pseudonym(`user:${principal.userId}`, "audit.actor").slice(0, 32),
        actor_role: principal.role,
        resource_type: "siem_destination",
        resource_ref: deps.crypto.pseudonym(`siem_destination:${row.publicId}`, "audit.resource").slice(0, 32),
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

      // Re-verify revision immediately before dialing so an intervening edit never dispatches a stale snapshot.
      const [currentRev] = await deps.db
        .select({ version: siemDestinations.version })
        .from(siemDestinations)
        .where(eq(siemDestinations.id, row.id))
        .limit(1);
      if (!currentRev) throw notFound("DESTINATION_NOT_FOUND");
      if (currentRev.version !== row.version) {
        throw conflict("VERSION_MISMATCH", "This destination was modified before the probe started. Reload and try again.");
      }

      const probeBudgetMs = Math.min(30_000, row.connectTimeoutMs + row.writeTimeoutMs + 2_000);
      const probeAbort = new AbortController();
      const probeTimer = setTimeout(() => probeAbort.abort(), probeBudgetMs);
      probeTimer.unref?.();

      let outcome: "completed" | "failed" | "unknown" = "failed";
      let reasonCode: string | null = null;
      let receiptConfirmation: SiemReceiptConfirmation = "none";

      try {
        const delivered = await deliverProjectedBatch({
          pool: probePool,
          dest: toTransportConfig(row, deps.config.deploymentProfile),
          secrets,
          events: [syntheticEvent],
          egress: getEgressPort(deps.services),
          signal: probeAbort.signal,
        });
        outcome = "completed";
        receiptConfirmation = delivered.receiptConfirmation;
      } catch (err) {
        const classified = classifySocketError(err, false);
        outcome = classified.uncertainAfterWrite ? "unknown" : "failed";
        reasonCode = classified.reasonCode;
        receiptConfirmation = "none";
      } finally {
        clearTimeout(probeTimer);
      }

      const finishedAt = deps.clock.now();
      const durationMs = Math.max(0, Math.round(performance.now() - startPerfMs));

      await deps.db.transaction(async (tx) => {
        // Only update test status on the tested configuration revision so concurrent edits are never overwritten.
        await tx
          .update(siemDestinations)
          .set({
            lastTestAt: finishedAt,
            lastTestOutcome: outcome,
            lastTestReason: reasonCode,
            updatedAt: finishedAt,
          })
          .where(and(eq(siemDestinations.id, row.id), eq(siemDestinations.version, row.version)));

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
              version: row.version,
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
    } finally {
      activeTestProbes.delete(input.publicId);
      await probePool.closeAll().catch(() => {});
    }
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
        uncertainDelivery: outbox.uncertainDelivery,
        lastReasonCode: outbox.lastReasonCode,
        correlationId: outbox.correlationId,
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
        const destIds = [...new Set(candidates.map((c) => c.destinationId))];
        const destRows = await tx
          .select({
            id: siemDestinations.id,
            version: siemDestinations.version,
            endpointGeneration: siemDestinations.endpointGeneration,
          })
          .from(siemDestinations)
          .where(inArray(siemDestinations.id, destIds))
          .for("update");
        const destById = new Map(destRows.map((d) => [d.id, d]));

        for (const destId of destIds) {
          const destMeta = destById.get(destId);
          if (!destMeta) continue;
          const groupIds = candidates.filter((c) => c.destinationId === destId).map((c) => c.id);
          await tx
            .update(siemOutbox)
            .set({
              state: "queued",
              attempts: 0,
              destinationVersion: destMeta.version,
              endpointGeneration: destMeta.endpointGeneration,
              nextAttemptAt: now,
              deadLetteredAt: null,
              updatedAt: now,
            })
            .where(inArray(siemOutbox.id, groupIds));
        }

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

  /**
   * Acquires an exclusive destination lease anchored to MySQL's authoritative `UTC_TIMESTAMP(3)` clock with:
   * - Unique per-claim-attempt `token` (`lease_<ulid>`) so retries of the same `jobId` never share identity.
   * - Destination-local monotonic `fence` (`lastFencingToken + 1`) so cross-job fencing tokens never block newer jobs.
   */
  async function acquireDestinationLease(destId: number, job?: ClaimedJob<unknown>): Promise<DestinationLease | null> {
    const now = deps.clock.now();
    const token = `lease_${ulid(now.getTime())}`;

    return deps.db.transaction(async (tx) => {
      if (job) await job.assertStillOwned(tx);

      const [row] = await tx
        .select()
        .from(siemDestinations)
        .where(
          and(
            eq(siemDestinations.id, destId),
            eq(siemDestinations.enabled, true),
            or(
              isNull(siemDestinations.leaseOwnerJobId),
              isNull(siemDestinations.leaseExpiresAt),
              sql`${siemDestinations.leaseExpiresAt} <= UTC_TIMESTAMP(3)`,
            ),
          ),
        )
        .for("update")
        .limit(1);

      if (!row) return null;

      const nextFence = row.lastFencingToken + 1;
      await tx
        .update(siemDestinations)
        .set({
          leaseOwnerJobId: token,
          leaseExpiresAt: sql`DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${LEASE_DURATION_SECONDS} SECOND)`,
          lastFencingToken: nextFence,
        })
        .where(eq(siemDestinations.id, row.id));

      const [updated] = await tx
        .select()
        .from(siemDestinations)
        .where(eq(siemDestinations.id, row.id))
        .limit(1);

      return {
        row: updated ?? { ...row, leaseOwnerJobId: token, lastFencingToken: nextFence },
        token,
        fence: nextFence,
      };
    });
  }

  async function releaseDestinationLease(destId: number, lease: DestinationLease): Promise<void> {
    await deps.db
      .update(siemDestinations)
      .set({ leaseOwnerJobId: null, leaseExpiresAt: null })
      .where(
        and(
          eq(siemDestinations.id, destId),
          eq(siemDestinations.leaseOwnerJobId, lease.token),
          eq(siemDestinations.lastFencingToken, lease.fence),
        ),
      );
  }

  async function assertDestinationLeaseInTx(
    tx: Tx,
    destId: number,
    lease: DestinationLease,
    expectedEndpointGen: number,
    expectedVersion?: number,
    job?: ClaimedJob<unknown>,
  ): Promise<{ locked: SiemDestinationRow; remainingLeaseMs: number }> {
    if (job) await job.assertStillOwned(tx);
    const [found] = await tx
      .select({
        row: siemDestinations,
        remainingUs: sql<number>`TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), ${siemDestinations.leaseExpiresAt})`,
      })
      .from(siemDestinations)
      .where(eq(siemDestinations.id, destId))
      .for("update")
      .limit(1);

    const remainingUs = Number(found?.remainingUs ?? 0);
    if (
      !found ||
      !found.row.enabled ||
      found.row.leaseOwnerJobId !== lease.token ||
      found.row.lastFencingToken !== lease.fence ||
      found.row.endpointGeneration !== expectedEndpointGen ||
      (expectedVersion !== undefined && found.row.version !== expectedVersion) ||
      !found.row.leaseExpiresAt ||
      remainingUs <= 0
    ) {
      throw conflict("LEASE_LOST", "Destination lease, revision, or endpoint generation changed or expired.");
    }
    return {
      locked: found.row,
      remainingLeaseMs: Math.max(0, Math.floor(remainingUs / 1_000)),
    };
  }

  async function projectEventsForDestination(params: {
    lease: DestinationLease;
    job?: ClaimedJob<unknown>;
    batchSize: number;
    maxAttempts: number;
    spoolMaxEvents: number;
  }): Promise<number> {
    const { lease, job, batchSize, maxAttempts, spoolMaxEvents } = params;
    const dest = lease.row;
    const auditPort = getAuditPort(deps.services);
    if (!auditPort) return 0;

    let cursor = dest.auditCursor;
    let lastSeq = dest.lastProjectedSeq;
    let totalProjected = 0;

    for (let pageIdx = 0; pageIdx < 10; pageIdx += 1) {
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
      const batchPruned = Math.max(0, Math.floor(batch.pruned ?? 0));
      const batchMissing = Math.max(0, Math.floor(batch.missing ?? 0));
      const cursorAdvanced = Boolean(batch.nextCursor && batch.nextCursor !== cursor);
      const now = deps.clock.now();

      // Caught up cleanly at headSeq with no new events, no cursor advance, and no gaps.
      if (batch.events.length === 0 && !cursorAdvanced && batchPruned === 0 && batchMissing === 0) {
        if (batch.headSeq <= lastSeq) {
          await deps.db
            .update(siemDestinations)
            .set({ lastCursorProgressAt: now })
            .where(
              and(
                eq(siemDestinations.id, dest.id),
                eq(siemDestinations.leaseOwnerJobId, lease.token),
                eq(siemDestinations.lastFencingToken, lease.fence),
              ),
            );
        }
        break;
      }

      const toInsert: (typeof siemOutbox.$inferInsert)[] = [];
      for (const rawEvent of batch.events) {
        if (typeof rawEvent.chain_seq === "number" && rawEvent.chain_seq > lastSeq) {
          lastSeq = rawEvent.chain_seq;
        }
        const projected = projectAuditEnvelopeForSiem(
          rawEvent,
          auditPort.projectForExternal ? (event) => auditPort.projectForExternal!(event) : undefined,
        );

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
          endpointGeneration: dest.endpointGeneration,
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
          uncertainDelivery: false,
          nextAttemptAt: now,
          correlationId: projected.correlation_id ?? job?.correlationId ?? null,
          createdAt: now,
          updatedAt: now,
        });
      }

      const nextCursor = batch.nextCursor ?? cursor;
      const cursorSeq = extractSeqFromAuditCursor(nextCursor);
      if (cursorSeq !== null && cursorSeq > lastSeq) {
        lastSeq = cursorSeq;
      }

      const insertedInPage = await deps.db.transaction(async (tx) => {
        await assertDestinationLeaseInTx(tx, dest.id, lease, dest.endpointGeneration, dest.version, job);

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
            lastCursorProgressAt: now,
            prunedAuditCount: sql`${siemDestinations.prunedAuditCount} + ${batchPruned}`,
            missingAuditGapCount: sql`${siemDestinations.missingAuditGapCount} + ${batchMissing}`,
            leaseExpiresAt: sql`DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${LEASE_DURATION_SECONDS} SECOND)`,
            updatedAt: now,
          })
          .where(eq(siemDestinations.id, dest.id));

        if (batchMissing > 0) {
          await deps.audit.record(
            {
              category: "security",
              eventName: "siem.audit.loss_detected",
              action: "observe",
              outcome: "failed",
              severity: "WARN",
              reasonCode: "AUDIT_EVENTS_MISSING",
              actor: { role: "system" },
              resource: { type: "siem_destination", publicId: dest.publicId },
              safeCounts: { missing: batchMissing, pruned: batchPruned },
              occurredAt: now,
            },
            tx,
          );
        }

        return toInsert.length;
      });

      if (batchPruned > 0) {
        deps.audit.note({
          category: "system",
          eventName: "siem.cursor.retention_pruned",
          action: "observe",
          outcome: "completed",
          severity: "INFO",
          reasonCode: "AUDIT_RETENTION_PRUNED",
          actor: { role: "system" },
          resource: { type: "siem_destination", publicId: dest.publicId },
          safeCounts: { pruned: batchPruned },
          occurredAt: now,
        });
      }

      totalProjected += insertedInPage;
      if (!cursorAdvanced) break;
      cursor = nextCursor;
    }

    return totalProjected;
  }

  async function transmitReadyBatchesForDestination(params: {
    lease: DestinationLease;
    job?: ClaimedJob<unknown>;
    batchSize: number;
    circuitThreshold: number;
    circuitCooldownSeconds: number;
  }): Promise<{ delivered: number; failed: number; deadLettered: number }> {
    const { lease, job, batchSize, circuitThreshold, circuitCooldownSeconds } = params;
    const destId = lease.row.id;
    let delivered = 0;
    let failed = 0;
    let deadLettered = 0;

    for (let round = 0; round < 5; round += 1) {
      if (job?.signal.aborted) break;
      const now = deps.clock.now();

      // Unconditionally verify active DB UTC lease, endpoint generation, and capture consistent revision BEFORE decrypting or dialing.
      let preflight: { locked: SiemDestinationRow; remainingLeaseMs: number };
      try {
        preflight = await deps.db.transaction(async (tx) =>
          assertDestinationLeaseInTx(tx, destId, lease, lease.row.endpointGeneration, undefined, job),
        );
      } catch {
        break;
      }

      if (preflight.remainingLeaseMs <= 750) {
        break;
      }

      const dest = preflight.locked;
      const snapshotVersion = dest.version;

      let effectiveCircuit = dest.circuitState as SiemCircuitState;
      if (effectiveCircuit === "open") {
        if (dest.circuitOpenUntil && dest.circuitOpenUntil.getTime() > now.getTime()) {
          break;
        }
        effectiveCircuit = "half_open";
      }

      const limit = effectiveCircuit === "half_open" ? Math.min(10, batchSize) : batchSize;

      // Strict per-destination FIFO head-of-line query: newer events never overtake a backed-off head event.
      const fifoHead: SiemOutboxRow[] = await deps.db
        .select()
        .from(siemOutbox)
        .where(
          and(
            eq(siemOutbox.destinationId, dest.id),
            eq(siemOutbox.state, "queued"),
            eq(siemOutbox.endpointGeneration, dest.endpointGeneration),
          ),
        )
        .orderBy(asc(siemOutbox.id))
        .limit(limit);

      if (fifoHead.length === 0) break;

      // Filter any queued rows that no longer match the current destination severity/category scope.
      const staleScopeIds = fifoHead
        .filter(
          (candidate) =>
            !matchesDestinationFilter(candidate.projectedJson, {
              minSeverity: dest.minSeverity as Severity,
              categories: dest.categoriesJson,
            }),
        )
        .map((r) => r.id);

      if (staleScopeIds.length > 0) {
        await deps.db.transaction(async (tx) => {
          await assertDestinationLeaseInTx(tx, dest.id, lease, dest.endpointGeneration, snapshotVersion, job);
          await tx.delete(siemOutbox).where(inArray(siemOutbox.id, staleScopeIds));
        });
        continue;
      }

      if (fifoHead[0]!.nextAttemptAt.getTime() > now.getTime()) {
        // Head of queue is still in retry backoff; preserve strict FIFO order.
        break;
      }

      const readyRows: SiemOutboxRow[] = [];
      for (const candidate of fifoHead) {
        if (candidate.nextAttemptAt.getTime() > now.getTime()) break;
        readyRows.push(candidate);
      }
      if (readyRows.length === 0) break;

      // Re-verify unexpired DB UTC lease + revision right before outbound network I/O and cap socket budget to remaining lease.
      let sendGuard: { locked: SiemDestinationRow; remainingLeaseMs: number };
      try {
        sendGuard = await deps.db.transaction(async (tx) =>
          assertDestinationLeaseInTx(tx, dest.id, lease, dest.endpointGeneration, snapshotVersion, job),
        );
      } catch {
        break;
      }
      if (sendGuard.remainingLeaseMs <= 750) {
        break;
      }

      const ioBudgetMs = Math.max(250, sendGuard.remainingLeaseMs - 500);
      const batchAbort = new AbortController();
      const onParentAbort = () => batchAbort.abort();
      job?.signal.addEventListener("abort", onParentAbort, { once: true });
      const leaseAbortTimer = setTimeout(() => batchAbort.abort(), ioBudgetMs);
      leaseAbortTimer.unref?.();

      let deliveryError: SiemTransportError | null = null;
      let receiptConfirmation: SiemReceiptConfirmation = "none";

      try {
        const secrets = await readDestinationSecretsFromRow(dest, deps.settings, deps.crypto);
        const baseTransport = toTransportConfig(dest, deps.config.deploymentProfile);
        const cappedTransport = {
          ...baseTransport,
          connectTimeoutMs: Math.min(baseTransport.connectTimeoutMs, ioBudgetMs),
          writeTimeoutMs: Math.min(baseTransport.writeTimeoutMs, ioBudgetMs),
        };
        const res = await deliverProjectedBatch({
          pool,
          dest: cappedTransport,
          secrets,
          events: readyRows.map((r) => r.projectedJson),
          egress: getEgressPort(deps.services),
          signal: batchAbort.signal,
        });
        receiptConfirmation = res.receiptConfirmation;
      } catch (err) {
        deliveryError = classifySocketError(err, false);
      } finally {
        clearTimeout(leaseAbortTimer);
        job?.signal.removeEventListener("abort", onParentAbort);
      }

      const completedAt = deps.clock.now();
      let cutoffStop = false;

      if (!deliveryError) {
        const rowIds = readyRows.map((r) => r.id);
        let countedDelivered = 0;
        await deps.db.transaction(async (tx) => {
          if (job) await job.assertStillOwned(tx);
          const [postRow] = await tx
            .select({
              row: siemDestinations,
              remainingUs: sql<number>`TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), ${siemDestinations.leaseExpiresAt})`,
            })
            .from(siemDestinations)
            .where(eq(siemDestinations.id, dest.id))
            .for("update")
            .limit(1);

          if (!postRow || postRow.row.endpointGeneration !== dest.endpointGeneration) {
            cutoffStop = true;
            return;
          }

          // Batch was accepted on this endpoint generation: remove outbox rows so they are never re-sent.
          await tx.delete(siemOutbox).where(inArray(siemOutbox.id, rowIds));
          countedDelivered = rowIds.length;

          const leaseStillValid =
            postRow.row.enabled &&
            postRow.row.version === snapshotVersion &&
            postRow.row.leaseOwnerJobId === lease.token &&
            postRow.row.lastFencingToken === lease.fence &&
            Boolean(postRow.row.leaseExpiresAt) &&
            Number(postRow.remainingUs ?? 0) > 0;

          if (!leaseStillValid) {
            // In-flight cutoff: destination revision changed or lease expired mid-flight; record deliveredCount only,
            // never overwriting the newer revision's circuit/receipt/failure state.
            await tx
              .update(siemDestinations)
              .set({
                deliveredCount: sql`${siemDestinations.deliveredCount} + ${rowIds.length}`,
              })
              .where(eq(siemDestinations.id, dest.id));
            cutoffStop = true;
            return;
          }

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
              leaseExpiresAt: sql`DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${LEASE_DURATION_SECONDS} SECOND)`,
              updatedAt: completedAt,
            })
            .where(eq(siemDestinations.id, dest.id));
        });
        delivered += countedDelivered;
        if (cutoffStop) break;
      } else {
        const reasonCode = deliveryError.reasonCode;
        const retryable = deliveryError.retryable;
        const uncertainAfterWrite = deliveryError.uncertainAfterWrite;

        let batchDeadLetters = 0;
        let recordedFailure = false;
        await deps.db.transaction(async (tx) => {
          if (job) await job.assertStillOwned(tx);
          const [postRow] = await tx
            .select({
              row: siemDestinations,
              remainingUs: sql<number>`TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), ${siemDestinations.leaseExpiresAt})`,
            })
            .from(siemDestinations)
            .where(eq(siemDestinations.id, dest.id))
            .for("update")
            .limit(1);

          if (!postRow || postRow.row.endpointGeneration !== dest.endpointGeneration) {
            cutoffStop = true;
            return;
          }

          const locked = postRow.row;
          const leaseStillValid =
            locked.enabled &&
            locked.version === snapshotVersion &&
            locked.leaseOwnerJobId === lease.token &&
            locked.lastFencingToken === lease.fence &&
            Boolean(locked.leaseExpiresAt) &&
            Number(postRow.remainingUs ?? 0) > 0;

          if (!leaseStillValid) {
            // In-flight cutoff: preserve post-write uncertainty on the outbox rows without overwriting newer destination config state.
            if (uncertainAfterWrite) {
              const rowIds = readyRows.map((r) => r.id);
              await tx
                .update(siemOutbox)
                .set({
                  uncertainDelivery: true,
                  lastReasonCode: reasonCode,
                  updatedAt: completedAt,
                })
                .where(and(inArray(siemOutbox.id, rowIds), eq(siemOutbox.endpointGeneration, dest.endpointGeneration)));
              await tx
                .update(siemDestinations)
                .set({
                  uncertainCount: sql`${siemDestinations.uncertainCount} + ${readyRows.length}`,
                })
                .where(eq(siemDestinations.id, dest.id));
            }
            cutoffStop = true;
            return;
          }

          recordedFailure = true;
          for (const item of readyRows) {
            const nextAttempts = item.attempts + 1;
            const exhaust = !retryable || nextAttempts >= item.maxAttempts;
            const markedUncertain = item.uncertainDelivery || uncertainAfterWrite;
            if (exhaust) {
              batchDeadLetters += 1;
              await tx
                .update(siemOutbox)
                .set({
                  state: "dead_letter",
                  attempts: nextAttempts,
                  uncertainDelivery: markedUncertain,
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
                  uncertainDelivery: markedUncertain,
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
              uncertainCount: uncertainAfterWrite
                ? sql`${siemDestinations.uncertainCount} + ${readyRows.length}`
                : locked.uncertainCount,
              leaseExpiresAt: sql`DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${LEASE_DURATION_SECONDS} SECOND)`,
              updatedAt: completedAt,
            })
            .where(eq(siemDestinations.id, dest.id));

          if (uncertainAfterWrite) {
            await deps.audit.record(
              {
                category: "system",
                eventName: "siem.delivery.uncertain_outcome",
                action: "observe",
                outcome: "unknown",
                severity: "WARN",
                reasonCode,
                actor: { role: "system" },
                resource: { type: "siem_destination", publicId: locked.publicId },
                safeCounts: { uncertain_events: readyRows.length },
                occurredAt: completedAt,
              },
              tx,
            );
          }

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

        if (recordedFailure) {
          failed += readyRows.length;
          deadLettered += batchDeadLetters;
        }
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

    let projected = 0;
    let delivered = 0;
    let failed = 0;
    let deadLettered = 0;

    for (const candidate of candidates) {
      if (job?.signal.aborted) break;
      const lease = await acquireDestinationLease(candidate.id, job);
      if (!lease) continue;

      try {
        projected += await projectEventsForDestination({
          lease,
          job,
          batchSize,
          maxAttempts,
          spoolMaxEvents,
        });

        const txResult = await transmitReadyBatchesForDestination({
          lease,
          job,
          batchSize,
          circuitThreshold,
          circuitCooldownSeconds,
        });
        delivered += txResult.delivered;
        failed += txResult.failed;
        deadLettered += txResult.deadLettered;
      } finally {
        await releaseDestinationLease(lease.row.id, lease).catch(() => {});
      }
    }

    return { projected, delivered, failed, deadLettered };
  }

  async function health(): Promise<ModuleHealth[]> {
    const checkedAt = deps.clock.now();
    const [oldestAlertSeconds, spoolMaxEvents, rows] = await Promise.all([
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
            maxCursorLagAgeSeconds: 0,
            missingAuditGaps: 0,
            prunedAuditEvents: 0,
          },
          checkedAt,
        },
      ];
    }

    const [statsMap, headSeq] = await Promise.all([
      loadOutboxStatsByDestination(rows.map((r) => r.id)),
      currentAuditHeadSeq(highestKnownCursor(rows)),
    ]);
    const enabledRows = rows.filter((r) => r.enabled);

    let totalQueued = 0;
    let totalDeadLetters = 0;
    let oldestPendingAgeSeconds = 0;
    let maxLagSeq = 0;
    let maxCursorLagAgeSeconds = 0;
    let totalMissingGaps = 0;
    let totalPrunedAudit = 0;

    for (const row of rows) {
      const s = statsMap.get(row.id);
      totalQueued += s?.queuedCount ?? 0;
      totalDeadLetters += s?.deadLetterCount ?? 0;
      totalMissingGaps += row.missingAuditGapCount;
      totalPrunedAudit += row.prunedAuditCount;
      if (row.enabled && s?.oldestQueuedCreatedAt) {
        const age = Math.max(0, Math.floor((checkedAt.getTime() - s.oldestQueuedCreatedAt.getTime()) / 1_000));
        if (age > oldestPendingAgeSeconds) oldestPendingAgeSeconds = age;
      }
      if (row.enabled) {
        const lag = Math.max(0, headSeq - row.lastProjectedSeq);
        if (lag > maxLagSeq) maxLagSeq = lag;
        if (lag > 0) {
          const baseline = row.lastCursorProgressAt ?? row.createdAt;
          const lagAge = Math.max(0, Math.floor((checkedAt.getTime() - baseline.getTime()) / 1_000));
          if (lagAge > maxCursorLagAgeSeconds) maxCursorLagAgeSeconds = lagAge;
        }
      }
    }

    const metrics = {
      configuredDestinations: rows.length,
      enabledDestinations: enabledRows.length,
      queueDepth: totalQueued,
      deadLetters: totalDeadLetters,
      oldestPendingAgeSeconds,
      maxLagSeq,
      maxCursorLagAgeSeconds,
      missingAuditGaps: totalMissingGaps,
      prunedAuditEvents: totalPrunedAudit,
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
    const hasMissingAuditGap = enabledRows.some((r) => r.missingAuditGapCount > 0);

    if (
      totalDeadLetters > 0 ||
      hasOpenCircuit ||
      hasExpiredCert ||
      hasSpoolSaturation ||
      hasSecretError ||
      hasMissingAuditGap
    ) {
      state = "failing";
      if (hasMissingAuditGap) {
        summary = "Unexplained sequence gaps were detected in the audit stream; verify audit chain integrity.";
      } else if (hasExpiredCert) {
        summary = "One or more enabled SIEM destinations have an expired TLS certificate.";
      } else if (hasSpoolSaturation) {
        summary =
          "A SIEM destination spool reached capacity; projection is paused at its current audit cursor (unprojected records remain subject to upstream audit retention until the spool drains).";
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
      const hasOverdueCursorLag = maxLagSeq > 0 && maxCursorLagAgeSeconds >= oldestAlertSeconds;

      if (hasExpiringSoonCert || hasHalfOpen || hasOldBacklog || hasOverdueCursorLag) {
        state = "degraded";
        if (hasOldBacklog) {
          summary = "Pending SIEM events exceed the configured delivery age threshold.";
        } else if (hasOverdueCursorLag) {
          summary = "One or more SIEM destinations are lagging behind the sealed audit head.";
        } else if (hasExpiringSoonCert) {
          summary = "A configured SIEM TLS certificate expires within 14 days.";
        } else {
          summary = "One or more SIEM destinations are retrying recent transport errors.";
        }
      }
    }

    return [{ component: "siem.delivery", state, summary, metrics, checkedAt }];
  }

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
