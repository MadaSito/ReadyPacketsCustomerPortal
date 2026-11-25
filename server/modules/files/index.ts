import { and, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import type { Readable } from "node:stream";
import type { ModuleDeps } from "../../container.js";
import { z } from "zod";
import { conflict, DomainError, forbidden, notFound, validation } from "../../core/errors.js";
import { randomToken, ULID_PATTERN, ulid } from "../../core/ids.js";
import { getRequestContext } from "../../core/requestContext.js";
import type { AuditEventInput, ClaimedJob, DbOrTx, JobResult, ModuleLifecycle, SessionPrincipal, StoredObjectInfo, Tx } from "../../core/types.js";
import { roleHasCapability, type Capability } from "../../../shared/capabilities.js";
import { stageKeySchema, type StageUploadIntent } from "../../../shared/workflowStages.js";
import { STEP_UP_MAX_AGE_MS } from "../../trpc/trpc.js";
import { registerAutomationTrigger } from "../automations/contracts.js";
import { readSetting, writeSetting } from "../platform/settingsRegistry.js";
import type { PublicApiProviders } from "../publicApi/ports.js";
import { acceptsDeclaredType, allowedExtensions, audioExtensions, classifyFile, displayExtension, documentExtensions, docxMime, sanitizeDisplayName, type FileClassification, type FileExtension } from "./classification.js";
import { audioJob, AudioConversionError, convertAudio, maxAudioOutputBytes, measureTaskAudio, probeAudioBinary } from "./audio.js";
import { fileAccessLog, fileDownloadTickets, filePlaybackGrants, orderFiles, type FileCategory, type FileVisibility } from "./schema.js";
import { parseAudioRange, type AudioRange } from "./playback.js";
import { assertPhaseRoom, limitsForPhase, verifyPhaseCapacity, type PhaseUsage, type UploadIntent } from "./governance.js";
export type { UploadIntent } from "./governance.js";
import { audioRulesSchema, audioRulesSetting, documentEditingRulesSchema, documentEditingSetting, fileRulesSetting, hardMaxFileBytes, hardMaxFiles, hardMaxRequestBytes, slotKeySchema, transcriptSchema, type AudioRules, type DocumentEditingRules, type FileRules } from "./settings.js";
import type { LocalObjectStorage } from "./storage.js";

export type { FileCategory, FileVisibility } from "./schema.js";
const ticketLifetimeMs = 60_000;
export const playbackLifetimeMs = 10 * 60_000;
const day = 86_400_000;
const retentionJob = "files.retention";
const maxAudioJobAttempts = 3;
const stagingKey = /^staging\/[a-f0-9]{32}$/u;
const filesKey = /^files\/[a-f0-9]{32}$/u;
const tokenShape = /^[a-zA-Z0-9_-]{43}$/u;
const publicIdShape = (value: string) => value.length === 26 && ULID_PATTERN.test(value);
type FileRow = typeof orderFiles.$inferSelect;
type AccessOutcome = typeof fileAccessLog.$inferInsert.outcome;

export interface FileRecord {
  publicId: string;
  logicalPublicId: string;
  orderPublicId: string;
  phasePublicId: string | null;
  statusKey: string | null;
  stageKey?: string | null;
  groupStageKey?: string | null;
  slotKey: string | null;
  derivedFromPublicId: string | null;
  derivedFromFileId?: string | null;
  conversionState: "converting" | "converted" | "failed" | null;
  conversionReason: string | null;
  durationSeconds: number | null;
  displayName: string;
  category: FileCategory;
  visibility: FileVisibility;
  size: number;
  sha256: string;
  contentType: string;
  extension: string;
  version: number;
  createdAt: Date;
  supersededAt: Date | null;
  deletedAt: Date | null;
}

export interface ListOptions {
  cursor?: string;
  limit?: number;
  includeVersions?: boolean;
  includeDeleted?: boolean;
  preferConvertedAudio?: boolean;
  stageKey?: string;
  phaseUploadKind?: "document" | "audio";
}
type Page<T> = { items: T[]; nextCursor: string | null };
type DeliverableFile = FileRecord & { stageKey: string | null };
type DeliverableScope = { orderPublicId: string; stageKey?: string };
type FilePhase = { key: string; label: string };
type PhaseLimits = ReturnType<typeof limitsForPhase>;
export type PortableStoredFile = FileRecord & { storageKey: string; orderId: number; ownerUserId: number; ownerPublicId: string };
export type BackupStoredFile = FileRecord & { storageKey: string };

export interface AdoptVerifiedObjectInput {
  principal: SessionPrincipal;
  publicId?: string;
  orderId: number;
  orderPublicId: string;
  ownerUserId: number;
  phasePublicId?: string | null;
  displayName: string;
  category: FileCategory;
  visibility: FileVisibility;
  stagedObject: StoredObjectInfo;
  destinationKey: string;
  contentType?: string;
  createdAt?: Date;
}

export type FileUploadSlot = {
  key: string; label: string; kind: "document" | "audio"; maxCount: number; allowedTypes: readonly string[];
  capture?: "record" | "upload" | "either"; maxMinutes?: number;
  acceptsUpload?: boolean; acceptsEdit?: boolean; sourceSlotKey?: string;
  task?: { kind: "upload" | "record" | "document_source" | "document_reply"; taskKey: string };
};
export type RecordingPreflightStatus = {
  enabled: boolean; conversionAvailable: boolean; maxMinutes: number; maxSeconds: number; maxBytes: number; acceptedTypes: string[];
};
export type PhasePolicy = {
  enabled: boolean; disabledReason: string | null; policy: UploadPolicy; maxSeconds: number;
  remainingDocuments: number | null; remainingAudio: number | null; remainingAudioSeconds: number | null;
};
export type DocumentLocator = { orderPublicId: string; filePublicId: string; taskKey?: string };
export type UploadOptions = { category: FileCategory; visibility: FileVisibility; versionOf?: string; slotKey?: string; statusKey?: string;
  source?: "recording" | "document_edit"; stageKey?: string; intent?: UploadIntent };
export type UploadAuthorization = UploadOptions & {
  orderId: number;
  orderPublicId: string;
  ownerUserId: number;
  statusKey: string;
  rules: FileRules;
  slot?: FileUploadSlot;
  taskKey?: string;
  phaseLimits?: PhaseLimits;
  maxAudioSeconds?: number;
  targetStatusKey?: string;
  requestedStageKey?: string;
};
export type StagedUpload = { info: StoredObjectInfo; classification: FileClassification; displayName: string };
export type Download = { file: FileRecord; stream: Readable };
export type UploadPolicy = Pick<FileRules, "extensions" | "maxFileBytes" | "maxRequestBytes" | "maxFiles">;
export interface FileScanProvider {
  scan(input: { stream: Readable; size: number; mime: string }): Promise<"clean" | "blocked">;
  health(): Promise<"ok" | "degraded" | "failing">;
}

export interface FilesModule extends ModuleLifecycle {
  beginUpload(principal: SessionPrincipal, orderPublicId: string, options: UploadOptions): Promise<UploadAuthorization>;
  stageUpload(name: string, stream: Readable, rules: FileRules): Promise<StagedUpload>;
  commitUpload(principal: SessionPrincipal, upload: UploadAuthorization, staged: StagedUpload, transcript?: string): Promise<FileRecord>;
  rejectUpload(principal: SessionPrincipal, orderPublicId: string, reason: string): Promise<void>;
  cleanUpload(staged: StagedUpload): Promise<void>;
  recordingPreflight(principal: SessionPrincipal, orderPublicId: string, slotKey?: string, stageKey?: string): Promise<RecordingPreflightStatus>;
  phasePolicy(principal: SessionPrincipal, orderPublicId: string, stageKey: string, intent: UploadIntent): Promise<PhasePolicy>;
  teamFiles(principal: SessionPrincipal, orderPublicId: string, stageKey: string, cursor?: string): Promise<Page<DeliverableFile>>;
  documentStatus(principal: SessionPrincipal, locator: DocumentLocator): Promise<{
    enabled: boolean; maxBytes: number; canEdit: boolean; disabledReason: string | null;
    agreementPolicyPublicId: string | null; agreementSignatureMode: "typed_name" | "checkbox" | null; file: FileRecord;
  }>;
  listDocumentVersions(principal: SessionPrincipal, locator: DocumentLocator): Promise<FileRecord[]>;
  openDocumentForEditing(principal: SessionPrincipal, locator: DocumentLocator): Promise<Download>;
  beginEditedVersion(principal: SessionPrincipal, locator: DocumentLocator): Promise<UploadAuthorization>;
  saveEditedVersion(principal: SessionPrincipal, upload: UploadAuthorization, staged: StagedUpload): Promise<FileRecord>;
  list(principal: SessionPrincipal, orderPublicId: string, options: ListOptions): Promise<Page<FileRecord> & {
    canUpload: boolean; uploadPolicy: UploadPolicy | null; uploadSlots: { statusKey: string; slots: FileUploadSlot[] } | null;
    audio: { enabled: boolean; maxMinutes: number } | null;
    phases: FilePhase[];
    currentStageKey: string | null;
    stageUploadsRequired: boolean;
    canArchiveOrder: boolean;
  }>;
  countFilesInSlot(orderId: number, slotKey: string, tx?: Tx, options?: { statusKey?: string }): Promise<number>;
  readTranscript(principal: SessionPrincipal, filePublicId: string): Promise<{ transcript: string | null }>;
  assertCanReadFile(principal: SessionPrincipal, filePublicId: string, orderPublicId?: string): Promise<FileRecord>;
  enumerateOrderFiles(principal: SessionPrincipal, orderPublicId: string, options?: ListOptions): Promise<Page<FileRecord>>;
  openForExport(principal: SessionPrincipal, filePublicId: string, orderPublicId: string, tx?: Tx): Promise<Download>;
  listDeliverableFiles(principal: SessionPrincipal, scope: DeliverableScope & { after?: string; limit?: number }, tx?: Tx): Promise<Page<DeliverableFile>>;
  openDeliverableFile(principal: SessionPrincipal, scope: DeliverableScope & { filePublicId: string }, tx?: Tx): Promise<{ file: DeliverableFile; stream: Readable }>;
  issueDownloadTicket(principal: SessionPrincipal, filePublicId: string): Promise<{ ticket: string; expiresAt: Date }>;
  redeemDownloadTicket(principal: SessionPrincipal, ticket: string): Promise<Download>;
  issuePlaybackTicket(principal: SessionPrincipal, orderPublicId: string, filePublicId: string): Promise<{ ticket: string }>;
  redeemPlaybackTicket(principal: SessionPrincipal, ticket: string): Promise<{ grantPublicId: string; secret: string }>;
  openPlayback(principal: SessionPrincipal, grantPublicId: string, secret: string, header: string | undefined, head: boolean):
    Promise<{ file: FileRecord; range: AudioRange; stream?: Readable }>;
  recordPlaybackAccess(principal: SessionPrincipal | null, outcome: AccessOutcome, file?: FileRecord, reason?: string, bytesSent?: number): Promise<void>;
  recordDownloadDenied(principal: SessionPrincipal | null, reason: string): Promise<void>;
  recordDownloadResult(principal: SessionPrincipal, filePublicId: string, outcome: "completed" | "failed" | "unknown"): Promise<void>;
  setVisibility(principal: SessionPrincipal, filePublicId: string, visibility: FileVisibility): Promise<FileRecord>;
  remove(principal: SessionPrincipal, filePublicId: string): Promise<FileRecord>;
  restore(principal: SessionPrincipal, filePublicId: string): Promise<FileRecord>;
  adminOverview(principal: SessionPrincipal): Promise<{
    rules: FileRules; storedFiles: number; storedBytes: string; retainedFiles: number; antivirus: "not_configured" | "configured";
    supported: UploadPolicy;
    audioRules: AudioRules; audioVersion: string | null;
    documentEditingRules: DocumentEditingRules;
  }>;
  setTypeRules(principal: SessionPrincipal, rules: FileRules): Promise<FileRules>;
  setAudioRules(principal: SessionPrincipal, rules: AudioRules): Promise<AudioRules>;
  setDocumentEditingRules(principal: SessionPrincipal, rules: DocumentEditingRules): Promise<DocumentEditingRules>;
  revokeTicketsForOrder(orderId: number, tx?: Tx): Promise<void>;
  reassignOrderFiles(orderId: number, ownerUserId: number, tx: Tx): Promise<void>;
  validatePortableObject(input: { stagedObject: StoredObjectInfo; displayName: string; category: FileCategory; contentType?: string }, tx?: Tx): Promise<{ extension: string; contentType: string }>;
  adoptVerifiedObject(input: AdoptVerifiedObjectInput, tx: Tx): Promise<FileRecord>;
  portableFiles(tx: Tx, options: { principal: SessionPrincipal; after?: string; limit: number; orderIds?: readonly number[] }): Promise<Page<PortableStoredFile>>;
  backupFiles(tx: Tx, options: { after?: string; limit: number }): Promise<Page<BackupStoredFile>>;
  /** Fenced storage-copy worker only; locks current order/file scope and returns private source metadata. */
  getOrderFileCopySource(filePublicId: string, tx: Tx): Promise<{
    storageKey: string; size: number; sha256: string; contentType: string; displayName: string; extension: string;
    visibility: FileVisibility; currentVersion: boolean;
    ownerUserId: number; customerName: string; customerReference: string; customerPublicId: string;
    orderReference: string; orderPublicId: string; orderName: string; filePublicId: string;
    statusKey: string | null; slotKey: string | null; stageKey: string | null; derivative: boolean;
    conversionState: FileRecord["conversionState"]; createdAt: Date;
  }>;
  /** Trusted console storage-transfer lookup; caller must first authorize access to this order. */
  listOrderFileCopyMetadata(orderPublicId: string, filePublicIds: readonly string[], tx: Tx): Promise<{
    filePublicId: string; displayName: string; statusKey: string | null; slotKey: string | null; stageKey: string | null; sourceAvailable: boolean;
  }[]>;
  /** Automation-only bounded traversal: null for unknown/held orders, ≥51 means do not copy the batch. */
  listOrderFileCopyCandidates(orderPublicId: string, tx: Tx, filePublicId?: string): Promise<string[] | null>;
  /** Trusted audit-trigger resolver; returns IDs/category only, never file bytes or names. */
  getUploadAutomationContext(filePublicId: string, handle: DbOrTx): Promise<{
    orderPublicId: string; orderOwnerUserId: number; category: FileCategory;
  } | null>;
}

registerAutomationTrigger({
  key: "file.uploaded",
  async resolveContext({ event, db, services, signal }) {
    signal.throwIfAborted();
    const filePublicId = event.resource?.type === "file" ? event.resource.publicId : null;
    if (!filePublicId || !publicIdShape(filePublicId)) return {};
    const context = await services.files.getUploadAutomationContext(filePublicId, db);
    if (!context) return {};
    const order = await services.orders.getOrderSyncView(context.orderPublicId, db);
    if (!order || order.ownerUserId !== context.orderOwnerUserId) return {};
    return {
      orderPublicId: order.publicId, filePublicId,
      fields: { file_category: context.category, order_reference: order.reference, order_status_label: order.status.label,
        order_link: new URL(`/orders/${order.publicId}`, services.config.canonicalOrigin).href },
      recipients: { order_owner: [order.ownerUserId] },
    };
  },
});

function boundedLimit(value = 30) {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw validation("INVALID_FILE_LIMIT", "Choose a file page size between 1 and 100.");
  return value;
}

function cursorValue(cursor?: string): string | undefined {
  if (cursor === undefined) return undefined;
  const value = Buffer.from(cursor, "base64url").toString("ascii");
  if (!publicIdShape(value) || Buffer.from(value, "ascii").toString("base64url") !== cursor) {
    throw validation("INVALID_FILE_CURSOR", "The file page cursor is invalid.");
  }
  return value;
}

const encodeCursor = (publicId: string) => Buffer.from(publicId, "ascii").toString("base64url");

export function createFilesModule(deps: ModuleDeps, { scanner }: { scanner?: FileScanProvider } = {}): FilesModule {
  const { db, clock, storage, audit, crypto, logger, settings } = deps;
  const local = storage as Partial<LocalObjectStorage>;
  const rules = (tx?: Tx) => readSetting(settings, fileRulesSetting, tx);
  const audioRules = (tx?: Tx) => readSetting(settings, audioRulesSetting, tx);
  const ffmpegBinary = () => deps.config.ffmpegPath;
  const currentTx = <T>(fn: (tx: Tx) => Promise<T>) => db.transaction(fn, { isolationLevel: "read committed" });
  let cachedProbe: { at: number; value: Promise<string | null> } | undefined;
  const audioVersion = () => {
    const now = clock.now().getTime();
    if (!cachedProbe || now - cachedProbe.at >= 60_000) cachedProbe = { at: now, value: probeAudioBinary(ffmpegBinary()) };
    return cachedProbe.value;
  };
  let retentionCursor: { after: Date; id: number } | undefined;

  function requireFull(principal: SessionPrincipal) {
    if (principal.state !== "full" || principal.pendingSteps.length > 0) {
      throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Please finish securing your account to continue.");
    }
  }

  async function requireCurrent(principal: SessionPrincipal, tx: Tx) {
    requireFull(principal);
    const current = await deps.services.identity.sessions.assertCurrent(principal, tx);
    if (current.pendingSteps.length) {
      throw new DomainError("REMEDIATION_REQUIRED", "ACCOUNT_STEP_PENDING", "Please finish securing your account to continue.");
    }
    return current;
  }

  function actor(principal: SessionPrincipal | null): NonNullable<AuditEventInput["actor"]> {
    return principal ? { userId: principal.userId, role: principal.role } : { role: "anonymous" };
  }

  function event(principal: SessionPrincipal | null, eventName: string, action: string, outcome: AuditEventInput["outcome"], publicId?: string, reasonCode?: string): AuditEventInput {
    return {
      category: "file", eventName, action, outcome, actor: actor(principal),
      ...(publicId ? { resource: { type: "file", publicId } } : {}),
      ...(reasonCode ? { reasonCode } : {}),
    };
  }

  function orderEvent(principal: SessionPrincipal, orderPublicId: string, reasonCode: string) {
    return audit.record({
      category: "file", eventName: "file.upload.denied", action: "upload", outcome: "denied", actor: actor(principal),
      resource: publicIdShape(orderPublicId) ? { type: "order", publicId: orderPublicId } : undefined,
      reasonCode,
    });
  }

  async function access(principal: SessionPrincipal | null, outcome: AccessOutcome, tx: Tx, filePublicId?: string, reason?: string,
    action = "download", orderPublicId?: string, attributes?: AuditEventInput["attributes"]) {
    const request = getRequestContext();
    await tx.insert(fileAccessLog).values({
      filePublicId, orderPublicId, action, userId: principal?.userId, requestId: request?.requestId, traceId: request?.traceId, correlationId: request?.correlationId,
      outcome, reasonCode: reason, createdAt: clock.now(),
    });
    const attempted = outcome === "attempted" || outcome === "denied";
    await audit.record({ ...event(principal, action === "playback" ? attempted ? "file.playback.access" : "file.playback.result" :
      action === "deliverable" ? "file.deliverable.open" : attempted ? "file.download" : "file.download.result",
    action, outcome, filePublicId, reason), orderPublicId, attributes }, tx);
  }

  function fullCapability(principal: SessionPrincipal, capability: Capability, stepUp = false) {
    requireFull(principal);
    if (!roleHasCapability(principal.role, capability)) throw forbidden("CAPABILITY_NOT_GRANTED");
    if (stepUp) {
      const age = principal.stepUpAt ? clock.now().getTime() - principal.stepUpAt.getTime() : Number.POSITIVE_INFINITY;
      if (age < 0 || age > STEP_UP_MAX_AGE_MS) {
        throw new DomainError("STEP_UP_REQUIRED", "STEP_UP_REQUIRED", "Please confirm your password and authentication code to continue.", { capability });
      }
    }
  }

  function output(row: FileRow, sourcePublicId?: string | null): DeliverableFile {
    return {
      publicId: row.publicId, logicalPublicId: row.logicalPublicId, orderPublicId: row.orderPublicId, phasePublicId: row.phasePublicId,
      slotKey: row.slotKey, derivedFromPublicId: row.derivedFromPublicId, conversionState: row.conversionState,
      conversionReason: row.conversionReason, durationSeconds: row.durationMs === null ? null : row.durationMs / 1000,
      statusKey: row.statusKey, stageKey: row.stageKey, displayName: crypto.decrypt(row.displayNameEnc, `order_files.display_name:${row.publicId}`),
      category: row.category, visibility: row.visibility, size: row.byteSize,
      sha256: row.sha256, contentType: row.contentType, extension: row.extension, version: row.version,
      createdAt: row.createdAt, supersededAt: row.supersededAt, deletedAt: row.deletedAt,
      ...(sourcePublicId !== undefined ? { derivedFromFileId: sourcePublicId } : {}),
    };
  }

  function copyDisplayName(row: Pick<FileRow, "displayNameEnc" | "publicId" | "extension" | "contentType" | "conversionState" | "stageKey">) {
    const original = crypto.decrypt(row.displayNameEnc, `order_files.display_name:${row.publicId}`);
    if (row.conversionState !== "failed" && (row.stageKey || !row.contentType.startsWith("audio/") || row.contentType === "audio/webm")) return original;
    const basename = Array.from(original.replace(/\.[^.]+$/u, "")).slice(0, 72).join("");
    return `${basename} (unconverted).${row.extension}`;
  }

  async function countFilesInSlot(orderId: number, slotKey: string, tx?: Tx, options?: { statusKey?: string }) {
    const [result] = await (tx ?? db).select({ count: count() }).from(orderFiles).where(and(
      eq(orderFiles.orderId, orderId), eq(orderFiles.slotKey, slotKey),
      options?.statusKey ? eq(orderFiles.statusKey, options.statusKey) : undefined,
      eq(orderFiles.visibility, "customer_visible"), isNull(orderFiles.supersededAt), isNull(orderFiles.deletedAt),
      isNull(orderFiles.purgedAt), isNull(orderFiles.derivedFromPublicId),
    ));
    return result?.count ?? 0;
  }

  async function resolveSlot(principal: SessionPrincipal, orderPublicId: string, statusKey: string, slotKey?: string, tx?: Tx) {
    if (!slotKey) return undefined;
    if (!slotKeySchema.safeParse(slotKey).success) throw validation("INVALID_UPLOAD_SLOT", "Choose a valid workflow upload slot.");
    const current = await deps.services.orders.getFileUploadSlots(principal, orderPublicId, tx);
    const slot = current.statusKey === statusKey && current.slots.find((item) => item.key === slotKey);
    if (!slot) throw new DomainError("FORBIDDEN", "UPLOAD_SLOT_UNAVAILABLE", "This upload slot is not available to you in the current status.");
    return slot;
  }

  function slotAllows(slot: FileUploadSlot, classification: FileClassification) {
    const correctKind = slot.kind === "audio" ? classification.mime.startsWith("audio/") :
      ["application/pdf", "image/png", "image/jpeg", docxMime].includes(classification.mime);
    return correctKind && (!slot.allowedTypes.length || slot.allowedTypes.includes(classification.extension));
  }

  function eligibleExtensions(policy: FileRules, slot?: FileUploadSlot, source?: UploadOptions["source"]) {
    const category: readonly string[] = source === "document_edit" ? ["docx"] :
      source === "recording" || slot?.kind === "audio" ? audioExtensions :
        slot?.kind === "document" ? documentExtensions : allowedExtensions;
    return policy.extensions.filter((extension) => category.includes(extension) &&
      (!slot?.allowedTypes.length || slot.allowedTypes.includes(extension)));
  }

  function assertSlotCapture(slot: FileUploadSlot | undefined, source: UploadOptions["source"]) {
    if (!slot) return;
    if (source === "document_edit" ? !slot.acceptsEdit : slot.acceptsUpload === false ||
      (slot.capture === "record" && source !== "recording") || (slot.capture === "upload" && source === "recording")) {
      throw validation("UPLOAD_TASK_METHOD", "Use the file or recording action allowed by this task.");
    }
  }

  function slotRoomError() {
    return conflict("UPLOAD_SLOT_FULL", "This upload slot has reached its file limit.");
  }

  async function findFile(publicId: string, handle: DbOrTx = db, forUpdate = false) {
    if (!publicIdShape(publicId)) throw notFound("FILE_NOT_FOUND");
    const query = handle.select().from(orderFiles).where(eq(orderFiles.publicId, publicId)).limit(1);
    const [file] = await (forUpdate ? query.for("update") : query);
    if (!file) throw notFound("FILE_NOT_FOUND");
    return file;
  }

  function enforceVisibility(row: FileRow, principal: SessionPrincipal, ownerUserId: number, includeDeleted = false) {
    if (row.ownerUserId !== ownerUserId || row.purgedAt || (!includeDeleted && row.deletedAt) ||
        (row.visibility === "staff_only" && !roleHasCapability(principal.role, "files.read_all"))) throw notFound("FILE_NOT_FOUND");
  }

  const publicPolicy = ({ extensions, maxFileBytes, maxRequestBytes, maxFiles }: FileRules): UploadPolicy =>
    ({ extensions, maxFileBytes, maxRequestBytes, maxFiles });

  const uploadIntent = (options: UploadOptions): StageUploadIntent =>
    options.source === "document_edit" ? "document_edit" : options.intent ?? (options.source === "recording" ? "recording" : "legacy");
  const sourceFor = (options: UploadOptions): UploadOptions["source"] =>
    options.intent === "recording" ? "recording" : options.source;

  async function resolveUploadStage(principal: SessionPrincipal, orderPublicId: string, options: UploadOptions, tx: Tx) {
    const stage = await deps.services.orders.stages?.resolveStageForUpload({
      orderPublicId, stageKey: options.stageKey, intent: uploadIntent(options), actor: principal, slotKey: options.slotKey,
    }, tx);
    if (options.stageKey && !stage) throw notFound("STAGE_NOT_OPEN");
    if (stage?.governance && !options.stageKey && options.source !== "document_edit") {
      throw validation("STAGE_REQUIRED", "Choose the phase this file belongs to.");
    }
    return stage ?? null;
  }

  function limitsForRequest(policy: FileRules, stage: { governance: Parameters<typeof limitsForPhase>[0] | null } | null, audio: AudioRules,
    options: UploadOptions, slot?: FileUploadSlot) {
    const intent = uploadIntent(options);
    const limits = stage?.governance ? limitsForPhase(stage.governance, policy.maxFileBytes, audio.maxMinutes * 60) : undefined;
    const isAudioIntent = intent === "recording" || intent === "prerecorded_audio";
    const category: readonly string[] = isAudioIntent ? audioExtensions : intent === "document" ? documentExtensions : allowedExtensions;
    const kindBytes = isAudioIntent || slot?.kind === "audio" ? limits?.audioMaxBytes
      : ["document", "document_edit"].includes(intent) || slot?.kind === "document" ? limits?.documentMaxBytes : undefined;
    const limitsRules = { ...policy, extensions: eligibleExtensions(policy, slot, sourceFor(options)).filter((value) => category.includes(value)),
      maxFileBytes: kindBytes ?? policy.maxFileBytes, maxFiles: sourceFor(options) || options.versionOf ? 1 : policy.maxFiles };
    const maxAudioSeconds = limits ? Math.min(limits.totalAudioMaxSeconds, audio.maxMinutes * 60,
      intent === "recording" ? limits.recordingMaxSeconds : Infinity, slot?.maxMinutes ? slot.maxMinutes * 60 : Infinity) :
      slot?.maxMinutes ? slot.maxMinutes * 60 : undefined;
    return { rules: limitsRules, phaseLimits: limits, maxAudioSeconds };
  }

  async function phaseUsage(orderId: number, stageKey: string, tx: Tx, exceptId?: number): Promise<PhaseUsage> {
    const [usage] = await tx.select({
      documents: sql<string>`COALESCE(SUM(${orderFiles.contentType} NOT LIKE 'audio/%'), 0)`,
      audio: sql<string>`COALESCE(SUM(${orderFiles.contentType} LIKE 'audio/%'), 0)`,
      audioDurationMs: sql<string>`COALESCE(SUM(CASE WHEN ${orderFiles.contentType} LIKE 'audio/%' THEN ${orderFiles.durationMs} END), 0)`,
      unverifiedAudio: sql<string>`COALESCE(SUM(${orderFiles.contentType} LIKE 'audio/%' AND (${orderFiles.durationMs} IS NULL OR ${orderFiles.durationMs} <= 0)), 0)`,
    }).from(orderFiles).where(and(eq(orderFiles.orderId, orderId), eq(orderFiles.stageKey, stageKey),
      isNull(orderFiles.deletedAt), isNull(orderFiles.purgedAt), isNull(orderFiles.supersededAt), isNull(orderFiles.derivedFromPublicId),
      exceptId ? ne(orderFiles.id, exceptId) : undefined));
    return { documents: Number(usage?.documents ?? 0), audio: Number(usage?.audio ?? 0), audioDurationMs: Number(usage?.audioDurationMs ?? 0),
      unverifiedAudio: Number(usage?.unverifiedAudio ?? 0) };
  }

  const listStages = (principal: SessionPrincipal, orderPublicId: string, tx: Tx) =>
    deps.services.orders.stages?.listForOrder({ orderPublicId, actor: principal }, tx);

  function statusStage(stages: Awaited<ReturnType<typeof listStages>> | undefined, statusKey: string | null) {
    return stages && statusKey && Object.hasOwn(stages.statusToStage, statusKey) ? stages.statusToStage[statusKey] ?? null : null;
  }

  function stageStatusKeys(stages: Awaited<ReturnType<typeof listStages>> | undefined, key: string) {
    if (!stageKeySchema.safeParse(key).success || !stages?.stages.some((entry) => entry.key === key && entry.viewable)) {
      throw notFound("STAGE_NOT_FOUND");
    }
    return stages.format === 3 ? [] : Object.entries(stages.statusToStage).filter(([, stage]) => stage === key).map(([status]) => status);
  }

  function phaseFilter(stageKey: string, legacyStatuses: string[]) {
    return or(eq(orderFiles.stageKey, stageKey), legacyStatuses.length ?
      and(isNull(orderFiles.stageKey), inArray(orderFiles.statusKey, legacyStatuses)) : undefined);
  }

  async function requireStageRead(principal: SessionPrincipal, row: FileRow, tx: Tx) {
    if (row.stageKey === null) return;
    stageStatusKeys(await listStages(principal, row.orderPublicId, tx), row.stageKey);
  }

  async function selectDeliverables(principal: SessionPrincipal, scope: DeliverableScope & {
    after?: string; limit?: number; team?: boolean; filePublicId?: string;
  }, tx: Tx) {
    requireFull(principal);
    const order = await deps.services.orders.assertCanReadOrder(principal, scope.orderPublicId, { tx, forUpdate: true });
    await requireCurrent(principal, tx);
    const stages = await listStages(principal, scope.orderPublicId, tx);
    const visibleStageKeys = stages?.stages.filter((entry) => entry.viewable).map((entry) => entry.key) ?? [];
    const phase = scope.stageKey ? phaseFilter(scope.stageKey, stageStatusKeys(stages, scope.stageKey)) :
      or(isNull(orderFiles.stageKey), visibleStageKeys.length ? inArray(orderFiles.stageKey, visibleStageKeys) : undefined);
    if (scope.team && scope.stageKey) {
      const access = await deps.services.orders.stages?.assertStageAccess({
        actor: principal, orderPublicId: scope.orderPublicId, stageKey: scope.stageKey, mode: "read",
      }, tx);
      if (!access?.stage.actions.teamFileReview) throw notFound("STAGE_TEAM_FILES_UNAVAILABLE");
    }
    const staff = roleHasCapability(principal.role, "files.read_all") && !scope.team;
    const limit = Math.max(1, Math.min(250, Number.isSafeInteger(scope.limit) ? scope.limit! : 100));
    const after = cursorValue(scope.after);
    const derivative = alias(orderFiles, "deliverable_derivative");
    // If the actor may see the published derivative, do not hand them both files.
    const hasDerivative = tx.select({ id: derivative.id }).from(derivative).where(and(
      eq(derivative.derivedFromPublicId, orderFiles.publicId), eq(derivative.orderId, order.id),
      eq(derivative.orderPublicId, order.publicId), eq(derivative.ownerUserId, order.ownerUserId),
      sql`${derivative.stageKey} <=> ${orderFiles.stageKey}`, sql`${derivative.statusKey} <=> ${orderFiles.statusKey}`,
      isNull(derivative.deletedAt), isNull(derivative.purgedAt), isNull(derivative.supersededAt), gt(derivative.byteSize, 0),
      staff ? undefined : eq(derivative.visibility, "customer_visible"),
      scope.team ? eq(derivative.category, "deliverable") : undefined,
    ));
    const rows = await tx.select().from(orderFiles).where(and(
      eq(orderFiles.orderId, order.id), eq(orderFiles.orderPublicId, order.publicId), eq(orderFiles.ownerUserId, order.ownerUserId), phase,
      isNull(orderFiles.deletedAt), isNull(orderFiles.purgedAt), isNull(orderFiles.supersededAt), gt(orderFiles.byteSize, 0),
      staff ? undefined : eq(orderFiles.visibility, "customer_visible"),
      scope.team ? eq(orderFiles.category, "deliverable") : undefined,
      scope.filePublicId ? eq(orderFiles.publicId, scope.filePublicId) : undefined,
      after ? gt(orderFiles.publicId, after) : undefined,
      notExists(hasDerivative),
    )).orderBy(orderFiles.publicId).limit(limit + 1).for("update");
    return { rows: rows.slice(0, limit), stages,
      nextCursor: rows.length > limit ? encodeCursor(rows[limit - 1]!.publicId) : null };
  }

  function deliverableOutput(row: FileRow, stages: Awaited<ReturnType<typeof listStages>>) {
    return { ...output(row), stageKey: row.stageKey ?? (stages?.format !== 3 ? statusStage(stages, row.statusKey) : null) };
  }

  async function readFile(principal: SessionPrincipal, publicId: string, orderPublicId?: string, tx?: Tx) {
    requireFull(principal);
    const initial = await findFile(publicId, tx);
    if (orderPublicId && initial.orderPublicId !== orderPublicId) throw notFound("FILE_NOT_FOUND");
    const order = await deps.services.orders.assertCanReadOrderById(principal, initial.orderId, { tx, forUpdate: !!tx });
    const file = tx ? await findFile(publicId, tx, true) : initial;
    if (file.orderPublicId !== order.publicId || file.orderId !== order.id) throw notFound("FILE_NOT_FOUND");
    enforceVisibility(file, principal, order.ownerUserId);
    if (tx) await requireStageRead(principal, file, tx);
    return file;
  }

  async function getPage(principal: SessionPrincipal, orderPublicId: string, options: ListOptions, tx: Tx) {
    requireFull(principal);
    const limit = boundedLimit(options.limit);
    const after = cursorValue(options.cursor);
    const order = await deps.services.orders.assertCanReadOrder(principal, orderPublicId, { tx, forUpdate: true });
    await requireCurrent(principal, tx);
    const staff = roleHasCapability(principal.role, "files.read_all");
    const stages = await listStages(principal, orderPublicId, tx);
    const stageKeys = stages?.stages.filter((entry) => entry.viewable).map((entry) => entry.key) ?? [];
    const selectedPhase = options.stageKey ? phaseFilter(options.stageKey, stageStatusKeys(stages, options.stageKey)) :
      or(isNull(orderFiles.stageKey), stageKeys.length ? inArray(orderFiles.stageKey, stageKeys) : undefined);
    const phaseUploads = options.phaseUploadKind;
    if (phaseUploads && (!options.stageKey || options.includeDeleted || options.includeVersions)) {
      throw validation("INVALID_PHASE_FILES_QUERY", "Select a phase to list current uploads.");
    }
    const orderScope = and(eq(orderFiles.orderId, order.id), eq(orderFiles.orderPublicId, order.publicId),
      eq(orderFiles.ownerUserId, order.ownerUserId), selectedPhase);
    const uploadScope = phaseUploads ? and(eq(orderFiles.visibility, "customer_visible"), ne(orderFiles.category, "deliverable"),
      phaseUploads === "audio" ? sql`${orderFiles.contentType} LIKE 'audio/%'` : sql`${orderFiles.contentType} NOT LIKE 'audio/%'`) : undefined;
    const pivot = phaseUploads && after
      ? (await tx.select({ createdAt: orderFiles.createdAt }).from(orderFiles)
        .where(and(orderScope, uploadScope, eq(orderFiles.publicId, after))).limit(1))[0]
      : undefined;
    if (phaseUploads && after && !pivot) throw validation("INVALID_PHASE_FILES_CURSOR", "Refresh the phase files and try again.");
    const pageBoundary = after ? pivot ? or(lt(orderFiles.createdAt, pivot.createdAt),
      and(eq(orderFiles.createdAt, pivot.createdAt), lt(orderFiles.publicId, after))) : gt(orderFiles.publicId, after) : undefined;
    if (options.includeDeleted && !staff) throw forbidden("CAPABILITY_NOT_GRANTED");
    let canUpload = ["owner", "contributor", "staff", "admin"].includes(order.accessRole) &&
      (order.lockState === "none" || (staff && order.lockState === "review"));
    if (canUpload && principal.role === "customer") {
      try {
        await deps.services.orders.gates.assertCustomerMayWork({ tx, orderId: order.id, actor: principal, action: "upload", statusKey: null });
      } catch (error) {
        if (!(error instanceof DomainError) || !["AGREEMENT_REQUIRED", "ORDER_ACCEPTANCE_REQUIRED", "ORDER_GATES_UNAVAILABLE"].includes(error.reasonCode)) throw error;
        // Keep the launcher available for the new MNDA: the write still fails before streaming,
        // allowing the UI to open the agreement and replay the explicit request upon acceptance.
        if (error.reasonCode !== "AGREEMENT_REQUIRED") canUpload = false;
      }
    }
    const rows = await tx.select().from(orderFiles).where(and(
      orderScope,
      uploadScope,
      isNull(orderFiles.purgedAt),
      options.includeDeleted ? undefined : isNull(orderFiles.deletedAt),
      options.includeVersions ? undefined : isNull(orderFiles.supersededAt),
      options.preferConvertedAudio && (!staff || phaseUploads) && !options.includeVersions
        ? sql`(${orderFiles.conversionState} IS NULL OR ${orderFiles.conversionState} <> 'converted')` : undefined,
      staff ? undefined : eq(orderFiles.visibility, "customer_visible"),
      pageBoundary,
    )).orderBy(...(phaseUploads ? [desc(orderFiles.createdAt), desc(orderFiles.publicId)] : [orderFiles.publicId])).limit(limit + 1).for("update");
    return {
      items: rows.slice(0, limit).map((row) => ({ ...output(row),
        groupStageKey: row.stageKey ?? (stages?.format !== 3 ? statusStage(stages, row.statusKey) : null) })),
      nextCursor: rows.length > limit ? encodeCursor(rows[limit - 1]!.publicId) : null,
      canUpload,
      phases: stages?.stages.filter((entry) => entry.viewable).map((entry) => ({ key: entry.key, label: staff ? entry.staffLabel : entry.customerLabel })) ?? [],
      currentStageKey: statusStage(stages, order.statusKey),
      stageUploadsRequired: stages?.format === 3,
      canArchiveOrder: principal.role === "admin" && roleHasCapability(principal.role, "files.archive.order"),
    };
  }

  async function classifyObject(info: StoredObjectInfo, displayName: string, options: FileRules) {
    if (!stagingKey.test(info.key) || displayExtension(displayName) === displayName) {
      throw validation("INVALID_FILE_REFERENCE", "The staged file reference is invalid.");
    }
    const extension = displayExtension(displayName);
    if (!options.extensions.includes(extension as FileExtension)) {
      throw validation("FILE_TYPE_DISABLED", "The file extension is not enabled for uploads.");
    }
    if (info.size <= 0 || info.size > options.maxFileBytes) {
      throw validation("INVALID_FILE_SIZE", "The file is empty or exceeds the allowed size.");
    }
    const classification = local.inspect
      ? await local.inspect(info.key, (read, size) => size === info.size ? classifyFile(read, size) : Promise.resolve(null))
      : await classifyFile(async (offset, length) => {
        const stream = await storage.get(info.key, { start: offset, end: offset + length - 1 });
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const raw of stream) {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
          size += chunk.length;
          if (size > length) throw validation("INVALID_FILE_SIZE", "The staged file could not be verified.");
          chunks.push(chunk);
        }
        return Buffer.concat(chunks, size);
      }, info.size);
    if (!classification || (classification.extension !== extension &&
        !(extension === "mp4" && classification.extension === "m4a" && classification.mime === "audio/mp4"))) {
      throw validation("FILE_TYPE_MISMATCH", "The file contents do not match an approved file type and extension.");
    }
    return { ...classification, extension };
  }

  async function validatePortable(input: Parameters<FilesModule["validatePortableObject"]>[0], tx?: Tx) {
    const displayName = sanitizeDisplayName(input.displayName);
    if (!stagingKey.test(input.stagedObject.key)) throw validation("INVALID_FILE_REFERENCE", "The staged file reference is invalid.");
    const options = await rules(tx);
    if (!Number.isSafeInteger(input.stagedObject.size) || input.stagedObject.size <= 0 || input.stagedObject.size > options.maxFileBytes) {
      throw validation("INVALID_FILE_SIZE", "The staged file is empty or exceeds the allowed size.");
    }
    const info = await storage.stat(input.stagedObject.key);
    if (!info || info.size !== input.stagedObject.size || info.sha256 !== input.stagedObject.sha256) {
      throw validation("FILE_INTEGRITY_MISMATCH", "The staged file could not be verified.");
    }
    const classification = await classifyObject(info, displayName, options);
    if (input.contentType !== undefined && !acceptsDeclaredType(classification, input.contentType)) {
      throw validation("FILE_TYPE_MISMATCH", "The file contents do not match the declared file type.");
    }
    return { info, classification, displayName };
  }

  async function cleanup(key: string) {
    await storage.delete(key).catch(() => logger.error("Private file cleanup requires attention"));
  }

  async function scanStaged(staged: StagedUpload) {
    if (!scanner) return;
    let stream: Readable | undefined;
    try {
      stream = await storage.get(staged.info.key);
      const result = await scanner.scan({ stream, size: staged.info.size, mime: staged.classification.mime });
      if (result === "blocked") throw validation("FILE_SCAN_REFUSED", "The file did not pass the configured scanning policy.");
      if (result === "clean" && stream.readableEnded) return;
      throw new Error("FILE_SCAN_INCOMPLETE");
    } catch (error) {
      if (error instanceof DomainError && error.reasonCode === "FILE_SCAN_REFUSED") throw error;
      throw new DomainError("UNAVAILABLE", "FILE_SCANNER_UNAVAILABLE", "The configured file scanner is unavailable.");
    } finally {
      stream?.destroy();
    }
  }

  async function readObject(row: FileRow): Promise<Readable> {
    try {
      return await storage.get(row.storageKey);
    } catch {
      throw new DomainError("UNAVAILABLE", "FILE_BYTES_UNAVAILABLE", "The private file is unavailable. Please try again later.");
    }
  }

  function assertPlayable(row: FileRow) {
    if (row.supersededAt || row.byteSize < 1 || !row.contentType.startsWith("audio/")) throw notFound("PLAYBACK_NOT_AVAILABLE");
  }

  async function withPlayback<T>(principal: SessionPrincipal, secret: string, grantPublicId: string | undefined,
    run: (row: FileRow, grant: typeof filePlaybackGrants.$inferSelect, tx: Tx) => Promise<T>): Promise<T> {
    const denied = () => notFound("PLAYBACK_NOT_AVAILABLE");
    try {
      requireFull(principal);
      if (!tokenShape.test(secret) || (grantPublicId !== undefined && !publicIdShape(grantPublicId))) throw denied();
      const hash = crypto.hashToken(secret);
      return await currentTx(async (tx) => {
        const [candidate] = await tx.select().from(filePlaybackGrants)
          .where(and(eq(filePlaybackGrants.tokenHash, hash), grantPublicId ? eq(filePlaybackGrants.publicId, grantPublicId) : undefined)).limit(1);
        const matches = (grant: typeof candidate) => grant && grant.userId === principal.userId &&
          grant.sessionId === principal.sessionId && grant.expiresAt > clock.now() &&
          grant.tokenHash === hash && (grant.redeemedAt !== null) === (grantPublicId !== undefined);
        if (!candidate || !matches(candidate)) throw denied();
        const order = await deps.services.orders.assertCanReadOrderById(principal, candidate.orderId, { tx, forUpdate: true });
        await requireCurrent(principal, tx);
        const [row] = await tx.select().from(orderFiles).where(eq(orderFiles.id, candidate.fileId)).limit(1).for("update");
        if (!row || row.orderId !== order.id || row.orderPublicId !== order.publicId) throw denied();
        enforceVisibility(row, principal, order.ownerUserId);
        await requireStageRead(principal, row, tx);
        assertPlayable(row);
        const [grant] = await tx.select().from(filePlaybackGrants).where(eq(filePlaybackGrants.id, candidate.id)).limit(1).for("update");
        if (!grant || !matches(grant)) throw denied();
        return run(row, grant, tx);
      });
    } catch (error) {
      if (error instanceof DomainError && ["NOT_FOUND", "FORBIDDEN", "UNAUTHENTICATED", "REMEDIATION_REQUIRED"].includes(error.code)) {
        await service.recordPlaybackAccess(principal, "denied", undefined, "PLAYBACK_NOT_AVAILABLE");
        throw denied();
      }
      throw error;
    }
  }

  async function insertVersion(tx: Tx, principal: SessionPrincipal, input: {
    publicId?: string; orderPublicId: string; orderId: number; ownerUserId: number; phasePublicId?: string | null;
    statusKey: string; stageKey?: string | null; category: FileCategory; visibility: FileVisibility; staged: StagedUpload; storageKey: string;
    previous?: FileRow; imported?: boolean; createdAt?: Date; slotKey?: string; transcript?: string; convertAudio?: boolean;
    source?: UploadOptions["source"]; intent?: UploadIntent; durationMs?: number; replyBranch?: boolean; conversionDisabled?: boolean;
  }) {
    const now = clock.now();
    const publicId = input.publicId ?? ulid(now.getTime());
    await tx.insert(orderFiles).values({
      publicId,
      logicalPublicId: input.replyBranch ? publicId : input.previous?.logicalPublicId ?? publicId,
      previousVersionId: input.previous?.id,
      orderPublicId: input.orderPublicId, orderId: input.orderId, ownerUserId: input.ownerUserId, phasePublicId: input.phasePublicId,
      statusKey: input.statusKey, stageKey: input.stageKey ?? input.previous?.stageKey,
      slotKey: input.slotKey,
      transcriptEnc: input.transcript ? crypto.encrypt(input.transcript, `order_files.transcript:${publicId}`) : null,
      conversionState: input.convertAudio ? "converting" : input.conversionDisabled ? "failed" : null,
      conversionReason: input.conversionDisabled ? "AUDIO_CONVERSION_DISABLED" : null,
      durationMs: input.durationMs,
      uploadedByUserId: principal.userId, storageKey: input.storageKey,
      displayNameEnc: crypto.encrypt(input.staged.displayName, `order_files.display_name:${publicId}`),
      category: input.category, visibility: input.visibility, byteSize: input.staged.info.size,
      sha256: input.staged.info.sha256, contentType: input.staged.classification.mime, extension: input.staged.classification.extension,
      version: input.replyBranch ? 1 : (input.previous?.version ?? 0) + 1, createdAt: input.createdAt ?? now,
    });
    if (input.previous && !input.replyBranch) {
      await tx.update(orderFiles).set({ supersededAt: now }).where(or(eq(orderFiles.id, input.previous.id),
        eq(orderFiles.derivedFromPublicId, input.previous.publicId)));
      const versions = await tx.select({ id: orderFiles.id }).from(orderFiles).where(or(eq(orderFiles.id, input.previous.id),
        eq(orderFiles.derivedFromPublicId, input.previous.publicId)));
      if (versions.length) await tx.delete(filePlaybackGrants).where(inArray(filePlaybackGrants.fileId, versions.map(({ id }) => id)));
    }
    await audit.record({ ...event(principal, input.imported ? "file.imported" : "file.uploaded",
      input.imported ? "import" : "upload", "completed", publicId),
      ...(!input.imported ? { orderPublicId: input.orderPublicId, attributes: {
        order_public_id: input.orderPublicId, file_visibility: input.visibility, file_source: input.intent ?? input.source ?? "upload",
        ...(input.stageKey ? { stage_key: input.stageKey } : {}),
      } } : {}) }, tx);
    if (input.source === "document_edit") {
      await audit.record({ ...event(principal, "file.edited_version_created", "edit_document", "completed", publicId),
        orderPublicId: input.orderPublicId, attributes: { source_file_public_id: input.previous?.publicId ?? "" } }, tx);
    }
    return output(await findFile(publicId, tx, true), input.source === "document_edit" ? input.previous?.publicId ?? null : undefined);
  }

  async function documentRules(tx?: Tx) {
    return readSetting(settings, documentEditingSetting, tx);
  }

  function isDocx(row: FileRow) {
    return row.extension === "docx" && row.contentType === docxMime && !row.derivedFromPublicId;
  }

  async function resolveDocumentEdit(principal: SessionPrincipal, locator: DocumentLocator, tx: Tx) {
    const order = await deps.services.orders.assertCanWriteOrder(principal, locator.orderPublicId, { kind: "file", tx, forUpdate: true });
    await requireCurrent(principal, tx);
    const row = await findFile(locator.filePublicId, tx, true);
    if (row.orderId !== order.id || row.orderPublicId !== order.publicId) throw notFound("FILE_NOT_FOUND");
    enforceVisibility(row, principal, order.ownerUserId);
    await requireStageRead(principal, row, tx);
    if (!row.stageKey) await deps.services.orders.assertFileStatusWritable(principal, order.publicId, order.statusKey, tx);
    if (!isDocx(row)) throw validation("DOCUMENT_NOT_EDITABLE", "Only supported Word documents can be edited in the portal.");
    if (row.supersededAt) throw conflict("FILE_VERSION_CHANGED", "This file already has a newer version.");
    if (row.slotKey && row.statusKey !== order.statusKey) {
      throw conflict("UPLOAD_SLOT_STATUS_CHANGED", "The document is not part of the current task.");
    }
    const [edit, policy] = await Promise.all([documentRules(tx), rules(tx)]);
    const maxBytes = Math.min(edit.maxBytes, policy.maxFileBytes, policy.maxRequestBytes - 1024);
    if (!edit.enabled || !policy.extensions.includes("docx")) throw forbidden("DOCUMENT_EDITING_DISABLED");
    if (row.byteSize > maxBytes) throw validation("DOCUMENT_TOO_LARGE", "This Word document exceeds the editor size limit.");
    let slot: FileUploadSlot | undefined;
    let replyBranch = false;
    if (principal.role === "customer") {
      if (order.ownerUserId !== principal.userId) throw forbidden("DOCUMENT_OWNER_REQUIRED");
      await deps.services.orders.gates.assertCustomerMayWork({
        tx, orderId: order.id, actor: principal, action: "edit_document", statusKey: order.statusKey,
      });
      if (row.slotKey || locator.taskKey) {
        if (row.statusKey !== order.statusKey) throw conflict("UPLOAD_SLOT_STATUS_CHANGED", "The document is not part of the current customer task.");
        const available = await deps.services.orders.getFileUploadSlots(principal, order.publicId, tx);
        const candidates = available.statusKey === order.statusKey ? available.slots.filter((item) =>
          item.kind === "document" && item.acceptsEdit && (!locator.taskKey || item.task?.taskKey === locator.taskKey) &&
          (item.key === row.slotKey || (!!row.slotKey && item.sourceSlotKey === row.slotKey))) : [];
        if (candidates.length !== 1) throw forbidden("DOCUMENT_TASK_EDIT_UNAVAILABLE");
        [slot] = candidates;
        replyBranch = slot!.key !== row.slotKey;
        if (replyBranch) {
          const branchRoots = tx.select({ logicalPublicId: orderFiles.logicalPublicId }).from(orderFiles).where(and(
            eq(orderFiles.previousVersionId, row.id), eq(orderFiles.orderId, order.id), eq(orderFiles.ownerUserId, order.ownerUserId),
            eq(orderFiles.statusKey, order.statusKey), eq(orderFiles.slotKey, slot!.key),
          ));
          const [existing] = await tx.select({ id: orderFiles.id }).from(orderFiles).where(and(
            inArray(orderFiles.logicalPublicId, branchRoots), eq(orderFiles.orderId, order.id), eq(orderFiles.ownerUserId, order.ownerUserId),
            isNull(orderFiles.deletedAt), isNull(orderFiles.purgedAt), isNull(orderFiles.supersededAt),
          )).limit(1);
          if (existing) throw conflict("DOCUMENT_REPLY_EXISTS", "A response already exists. Edit the current response instead.");
          if (await countFilesInSlot(order.id, slot!.key, tx, { statusKey: order.statusKey }) >= slot!.maxCount) throw slotRoomError();
        }
      } else if (row.category === "deliverable") {
        // A deliverable can only be edited by a customer as a response to an explicit document task.
        throw forbidden("DOCUMENT_TASK_EDIT_UNAVAILABLE");
      }
    } else {
      fullCapability(principal, "files.manage");
      if (!row.stageKey && row.statusKey && row.statusKey !== order.statusKey) {
        await deps.services.orders.assertFileStatusWritable(principal, order.publicId, row.statusKey, tx);
      }
    }
    if (slot && !slotAllows(slot, { extension: "docx", mime: docxMime })) throw forbidden("DOCUMENT_TASK_EDIT_UNAVAILABLE");
    const options: UploadOptions = { stageKey: row.stageKey ?? undefined, slotKey: slot?.key ?? row.slotKey ?? undefined,
      versionOf: row.publicId, category: replyBranch ? "supporting" : row.category, visibility: row.visibility, source: "document_edit" };
    const stage = await resolveUploadStage(principal, order.publicId, options, tx);
    if (!row.stageKey && stage?.governance && !replyBranch) {
      throw validation("FILE_VERSION_SCOPE", "A new version must preserve its original phase.");
    }
    if (row.stageKey && !stage?.governance) {
      await deps.services.orders.assertFileStatusWritable(principal, order.publicId, row.statusKey ?? order.statusKey, tx);
    }
    const documentPolicy = { ...policy, maxFileBytes: maxBytes,
      maxRequestBytes: Math.min(policy.maxRequestBytes, maxBytes + 16 * 1024), maxFiles: 1, extensions: ["docx"] as FileExtension[] };
    const effective = limitsForRequest(documentPolicy, stage, await audioRules(tx), options, slot);
    if (row.byteSize > effective.rules.maxFileBytes) throw validation("DOCUMENT_TOO_LARGE", "This Word document exceeds the phase file size limit.");
    return { row, order, slot, replyBranch, options, stage, effective, policy: effective.rules };
  }

  async function documentOutput(row: FileRow, principal: SessionPrincipal, tx: Tx) {
    const [previous] = row.previousVersionId ? await tx.select().from(orderFiles).where(and(eq(orderFiles.id, row.previousVersionId),
      eq(orderFiles.orderId, row.orderId), eq(orderFiles.ownerUserId, row.ownerUserId))).limit(1) : [];
    const source = previous && !previous.deletedAt && !previous.purgedAt &&
      (previous.visibility === "customer_visible" || roleHasCapability(principal.role, "files.read_all")) ? previous.publicId : null;
    return output(row, source);
  }

  /** Object-level write denials raised inside the write transaction (review F-1): recorded durably AFTER it has
   *  rolled back, never on a second pool connection while the tx is held. Best effort: the request is refused
   *  regardless. Capability refusals before the tx are recorded by the tRPC capability guard. */
  const deniedCodes = new Set(["NOT_FOUND", "FORBIDDEN", "LOCKED", "REMEDIATION_REQUIRED", "STEP_UP_REQUIRED", "UNAUTHENTICATED"]);
  async function recordWriteDenied(principal: SessionPrincipal, filePublicId: string, action: string, error: unknown) {
    if (!(error instanceof DomainError) || !deniedCodes.has(error.code)) return;
    await audit.record({
      category: "security", eventName: "file.access.denied", action, outcome: "denied", severity: "WARN",
      actor: actor(principal), reasonCode: error.reasonCode,
      ...(publicIdShape(filePublicId) ? { resource: { type: "file", publicId: filePublicId } } : {}),
    }).catch(() => undefined);
  }

  async function writeFile(principal: SessionPrincipal, filePublicId: string, change: { visibility: FileVisibility } | "delete" | "restore") {
    fullCapability(principal, typeof change === "object" ? "files.visibility.change" : "files.manage");
    const policy = change === "delete" ? await rules() : null;
    try {
      return await writeFileInTx(principal, filePublicId, change, policy);
    } catch (error) {
      await recordWriteDenied(principal, filePublicId, typeof change === "object" ? "update" : change, error);
      throw error;
    }
  }

  function writeFileInTx(principal: SessionPrincipal, filePublicId: string, change: { visibility: FileVisibility } | "delete" | "restore", policy: FileRules | null) {
    return currentTx(async (tx) => {
      const initial = await findFile(filePublicId, tx);
      const order = await deps.services.orders.assertCanWriteOrderById(principal, initial.orderId, { kind: "file", tx, forUpdate: true });
      await requireCurrent(principal, tx);
      const row = await findFile(filePublicId, tx, true);
      enforceVisibility(row, principal, order.ownerUserId, true);
      if (row.orderPublicId !== order.publicId) throw notFound("FILE_NOT_FOUND");
      if (row.derivedFromPublicId) throw new DomainError("FORBIDDEN", "AUDIO_DERIVATIVE_READ_ONLY", "Change or remove the original recording instead.");
      const stages = row.stageKey ? await listStages(principal, order.publicId, tx) : undefined;
      if (row.stageKey) stageStatusKeys(stages, row.stageKey);
      const stage = row.stageKey && stages?.format === 3 ? await deps.services.orders.stages?.assertStageAccess({
        orderPublicId: order.publicId, actor: principal, stageKey: row.stageKey, mode: "staff_manage",
      }, tx) : undefined;
      if (row.stageKey && stages?.format === 3 && !stage) throw notFound("STAGE_NOT_FOUND");
      if (!stage && row.statusKey) await deps.services.orders.assertFileStatusWritable(principal, order.publicId, row.statusKey, tx);
      if (row.slotKey && row.statusKey && !row.supersededAt &&
          ((typeof change === "object" && change.visibility === "customer_visible" && row.visibility === "staff_only") ||
            (change === "restore" && row.visibility === "customer_visible"))) {
        const slot = await deps.services.orders.getFileSlotForCustody(order.publicId, row.statusKey, row.slotKey, tx);
        if (!slot) throw forbidden("UPLOAD_SLOT_UNAVAILABLE");
        if (await countFilesInSlot(order.id, slot.key, tx, { statusKey: row.statusKey }) >= slot.maxCount) throw slotRoomError();
      }
      const now = clock.now();
      let outcome: AuditEventInput["outcome"] = "completed";
      let reasonCode: string | undefined;
      let attributes: AuditEventInput["attributes"];
      if (typeof change === "object") {
        if (row.deletedAt) throw notFound("FILE_NOT_FOUND");
        await tx.update(orderFiles).set(change).where(or(eq(orderFiles.id, row.id), eq(orderFiles.derivedFromPublicId, row.publicId)));
        attributes = { from_visibility: row.visibility, to_visibility: change.visibility };
      } else if (change === "delete" && row.deletedAt) {
        // Review F-2: a repeated delete changes nothing and must not claim a completed removal.
        outcome = "refused";
        reasonCode = "ALREADY_REMOVED";
      } else if (change === "delete") {
        await tx.update(orderFiles).set({ deletedAt: now, purgeAfter: new Date(now.getTime() + policy!.retentionDays * day) })
          .where(or(eq(orderFiles.id, row.id), eq(orderFiles.derivedFromPublicId, row.publicId)));
      } else if (change === "restore") {
        if (!row.deletedAt || !row.purgeAfter || row.purgeAfter <= now) {
          throw conflict("FILE_NOT_RESTORABLE", "The file is not available to restore.");
        }
        if (row.stageKey && stage && !row.supersededAt && stages?.format === 3) {
          const [policy, audio] = await Promise.all([rules(tx), audioRules(tx)]);
          const limits = limitsForPhase(stage.stage.governance ?? {}, policy.maxFileBytes, audio.maxMinutes * 60);
          const usage = await phaseUsage(order.id, row.stageKey, tx);
          verifyPhaseCapacity(limits, usage, row.contentType.startsWith("audio/"), row.byteSize, row.durationMs ?? undefined);
        }
        await tx.update(orderFiles).set({ deletedAt: null, purgeAfter: null })
          .where(and(or(eq(orderFiles.id, row.id), eq(orderFiles.derivedFromPublicId, row.publicId)), isNull(orderFiles.purgedAt)));
      }
      await tx.delete(fileDownloadTickets).where(eq(fileDownloadTickets.fileId, row.id));
      const [derived] = await tx.select({ id: orderFiles.id }).from(orderFiles).where(eq(orderFiles.derivedFromPublicId, row.publicId)).limit(1);
      if (derived) await tx.delete(fileDownloadTickets).where(eq(fileDownloadTickets.fileId, derived.id));
      await tx.delete(filePlaybackGrants).where(inArray(filePlaybackGrants.fileId, derived ? [row.id, derived.id] : [row.id]));
      await audit.record({
        ...event(principal, typeof change === "object" ? "file.visibility.changed" : change === "delete" ? "file.removed" : "file.restored",
          typeof change === "object" ? "update" : change, outcome, filePublicId, reasonCode),
        ...(attributes ? { attributes } : {}),
      }, tx);
      return output(await findFile(filePublicId, tx, true));
    });
  }

  deps.jobs.register(retentionJob, async (job) => {
    await job.assertStillOwned();
    const now = clock.now();
    const stagingRemoved = await local.sweepStaging?.(new Date(now.getTime() - 2 * day), job.signal) ?? 0;
    const expired = await db.select({ id: fileDownloadTickets.id }).from(fileDownloadTickets)
      .where(lte(fileDownloadTickets.expiresAt, now)).orderBy(fileDownloadTickets.expiresAt).limit(1000);
    if (expired.length) await db.delete(fileDownloadTickets).where(inArray(fileDownloadTickets.id, expired.map(({ id }) => id)));
    const grants = await db.select({ id: filePlaybackGrants.id }).from(filePlaybackGrants)
      .where(lte(filePlaybackGrants.expiresAt, now)).orderBy(filePlaybackGrants.expiresAt).limit(1000);
    if (grants.length) await db.delete(filePlaybackGrants).where(inArray(filePlaybackGrants.id, grants.map(({ id }) => id)));
    const candidates = await db.select({
      id: orderFiles.id, orderId: orderFiles.orderId, publicId: orderFiles.publicId, purgeAfter: orderFiles.purgeAfter,
    }).from(orderFiles)
      .where(and(isNotNull(orderFiles.deletedAt), lte(orderFiles.purgeAfter, now), isNull(orderFiles.purgedAt),
        retentionCursor ? or(gt(orderFiles.purgeAfter, retentionCursor.after),
          and(eq(orderFiles.purgeAfter, retentionCursor.after), gt(orderFiles.id, retentionCursor.id))) : undefined))
      .orderBy(orderFiles.purgeAfter, orderFiles.id).limit(100);
    let purged = 0;
    for (const candidate of candidates) {
      job.signal.throwIfAborted();
      await job.assertStillOwned();
      const initialOrder = await deps.services.orders.getOrderRefById(candidate.orderId);
      if (!initialOrder || initialOrder.lockState === "legal_hold") continue;
      const input: AuditEventInput = {
        category: "file", eventName: "file.retention.purged", action: "purge", outcome: "attempted",
        actor: { role: "system" }, resource: { type: "file", publicId: candidate.publicId }, correlationId: job.correlationId, jobId: job.jobId,
      };
      // Commit intent before acquiring the publication transaction. A lost commit after an unlink
      // leaves a durable attempted event; the retry can safely unlink an already absent object.
      await audit.record(input);
      const didPurge = await currentTx(async (tx) => {
        await job.assertStillOwned(tx);
        const order = await deps.services.orders.getOrderRefById(candidate.orderId, tx, { forUpdate: true });
        if (!order || order.lockState === "legal_hold") return false;
        const [row] = await tx.select().from(orderFiles).where(eq(orderFiles.id, candidate.id)).limit(1).for("update");
        if (!row?.deletedAt || !row.purgeAfter || row.purgedAt || row.purgeAfter > now) return false;
        if (row.orderId !== order.id || row.orderPublicId !== order.publicId || row.publicId !== candidate.publicId) return false;
        await audit.record({ ...input, outcome: "completed" }, tx);
        job.signal.throwIfAborted();
        await storage.delete(row.storageKey);
        await tx.update(orderFiles).set({ purgedAt: now }).where(eq(orderFiles.id, row.id));
        return true;
      });
      if (didPurge) purged++;
    }
    // Cycle through due rows so a batch of held orders cannot indefinitely starve later files.
    const last = candidates.at(-1);
    retentionCursor = candidates.length === 100 && last?.purgeAfter ? { after: last.purgeAfter, id: last.id } : undefined;
    return { outcome: "completed", safeCounts: { purged, stagingRemoved, expiredTickets: expired.length } };
  });
  deps.jobs.registerSchedule({ name: retentionJob, type: retentionJob, everyMs: 60 * 60_000 });

  const conversionPayload = z.strictObject({
    filePublicId: z.string().length(26).regex(ULID_PATTERN), taskMaxMinutes: z.number().int().min(1).max(120).optional(),
  });
  function audioAudit(job: ClaimedJob, tx: Tx, row: FileRow, outcome: "attempted" | "completed" | "failed", reasonCode?: string) {
    return audit.record({ category: "file", eventName: "file.audio.conversion", action: "convert", outcome,
      actor: { role: "system" }, resource: { type: "file", publicId: row.publicId }, orderPublicId: row.orderPublicId,
      attributes: { file_visibility: row.visibility }, reasonCode, jobId: job.jobId, correlationId: job.correlationId }, tx);
  }
  deps.jobs.register(audioJob, async (job): Promise<JobResult> => {
    const args = conversionPayload.safeParse(job.payload);
    if (!args.success) return { outcome: "failed", reasonCode: "AUDIO_JOB_INVALID", retryable: false };
    const { filePublicId, taskMaxMinutes } = args.data;
    const unavailable = (reasonCode: string) => ({ outcome: "failed" as const, reasonCode, retryable: false });
    const [initial] = await db.select().from(orderFiles).where(eq(orderFiles.publicId, filePublicId)).limit(1);
    if (!initial || initial.conversionState !== "converting") return { outcome: "completed" };
    async function lockSource(tx: Tx) {
      await job.assertStillOwned(tx);
      const order = await deps.services.orders.getOrderRefById(initial!.orderId, tx, { forUpdate: true });
      const row = await findFile(filePublicId, tx, true);
      const valid = !!order && order.publicId === row.orderPublicId && row.orderId === initial!.orderId &&
        order.ownerUserId === row.ownerUserId && row.ownerUserId === initial!.ownerUserId && order.lockState === "none" &&
        !row.derivedFromPublicId && !row.deletedAt && !row.purgedAt &&
        !row.supersededAt && row.storageKey === initial!.storageKey && row.sha256 === initial!.sha256 && row.contentType.startsWith("audio/");
      // A derivative is a system artifact of an already admitted file, not additional customer work.
      // The phase can finish while this job waits; retain its captured status and slot for custody.
      return { row, valid };
    }
    async function stop(row: FileRow, reason: string, tx: Tx, copyable: boolean) {
      await tx.update(orderFiles).set({ conversionState: "failed", conversionReason: reason }).where(eq(orderFiles.id, row.id));
      await audioAudit(job, tx, row, "failed", reason);
      if (copyable && reason !== "AUDIO_SOURCE_INTEGRITY" && reason !== "FILE_BYTES_UNAVAILABLE") {
        await deps.services.storageConnections?.stageOrderFile(row.publicId, tx, { orderPublicId: row.orderPublicId });
      }
      return unavailable(reason);
    }
    const prepared = await currentTx(async (tx) => {
      const { row, valid } = await lockSource(tx);
      if (row.conversionState !== "converting") return { result: { outcome: "completed" as const } };
      if (!valid) return { result: await stop(row, "AUDIO_SOURCE_INACTIVE", tx, false) };
      const policy = await audioRules(tx);
      if (!policy.enabled) return { result: await stop(row, "AUDIO_CONVERSION_DISABLED", tx, valid) };
      await audioAudit(job, tx, row, "attempted");
      return { row, policy: { ...policy, maxMinutes: taskMaxMinutes ?? policy.maxMinutes } };
    });
    if (prepared.result) return prepared.result;
    const staging = storage.newKey("staging");
    const destination = storage.newKey("files");
    let placementAttempted = false;
    try {
      if (!local.withConversionDirectory) throw new AudioConversionError("AUDIO_CONVERSION_UNAVAILABLE");
      await job.assertStillOwned();
      const input = await readObject(prepared.row);
      let converted: { info: StoredObjectInfo; durationMs: number };
      try {
        converted = await local.withConversionDirectory((directory) => convertAudio({
          binary: ffmpegBinary(), directory, input, size: prepared.row.byteSize, sha256: prepared.row.sha256,
          extension: prepared.row.extension, rules: prepared.policy, signal: job.signal,
          accept: async (output, durationMs) => ({ durationMs, info: await storage.put(staging, output, { maxBytes: maxAudioOutputBytes }) }),
        }));
      } finally { input.destroy(); }
      await scanStaged({ info: converted.info, classification: { extension: "webm", mime: "audio/webm" }, displayName: "converted.webm" });
      return await currentTx(async (tx) => {
        const { row, valid } = await lockSource(tx);
        if (row.conversionState !== "converting") return { outcome: "completed" };
        if (!valid) return stop(row, "AUDIO_SOURCE_INACTIVE", tx, false);
        const policy = await audioRules(tx);
        if (!policy.enabled || (taskMaxMinutes ?? policy.maxMinutes) !== prepared.policy.maxMinutes || policy.bitrateKbps !== prepared.policy.bitrateKbps) {
          return stop(row, "AUDIO_POLICY_CHANGED", tx, valid);
        }
        const publicId = ulid(clock.now().getTime());
        const displayName = sanitizeDisplayName(`${output(row).displayName.replace(/\.[^.]+$/u, "").slice(0, 120)} (WebM).webm`);
        placementAttempted = true;
        await storage.move(staging, destination);
        await tx.insert(orderFiles).values({
          publicId, logicalPublicId: publicId, derivedFromPublicId: row.publicId, statusKey: row.statusKey, slotKey: row.slotKey, stageKey: row.stageKey,
          orderId: row.orderId, orderPublicId: row.orderPublicId, ownerUserId: row.ownerUserId, phasePublicId: row.phasePublicId,
          category: row.category, visibility: row.visibility, durationMs: converted.durationMs, uploadedByUserId: row.uploadedByUserId,
          displayNameEnc: crypto.encrypt(displayName, `order_files.display_name:${publicId}`), storageKey: destination,
          byteSize: converted.info.size, sha256: converted.info.sha256, contentType: "audio/webm", extension: "webm", createdAt: clock.now(),
        });
        await tx.update(orderFiles).set({ conversionState: "converted", durationMs: row.durationMs ?? converted.durationMs, conversionReason: null })
          .where(eq(orderFiles.id, row.id));
        await deps.services.storageConnections?.stageOrderFile(publicId, tx, { orderPublicId: row.orderPublicId });
        await audioAudit(job, tx, row, "completed");
        return { outcome: "completed", safeCounts: { converted: 1 } };
      });
    } catch (error) {
      if (placementAttempted) {
        const committed = await db.select({ id: orderFiles.id }).from(orderFiles).where(eq(orderFiles.storageKey, destination)).limit(1)
          .then((rows) => rows.length > 0).catch(() => undefined);
        if (committed === false) await cleanup(destination);
        else if (committed === undefined) logger.warn("Audio conversion publication requires reconciliation");
      }
      job.signal.throwIfAborted();
      const safeReason = error instanceof AudioConversionError ? error.reasonCode :
        error instanceof DomainError && ["FILE_SCANNER_UNAVAILABLE", "FILE_SCAN_REFUSED", "FILE_BYTES_UNAVAILABLE"].includes(error.reasonCode)
          ? error.reasonCode : undefined;
      if (!safeReason && job.attempt < maxAudioJobAttempts) throw error;
      const reason = safeReason ?? "AUDIO_CONVERSION_FAILED";
      return currentTx(async (tx) => {
        const { row, valid } = await lockSource(tx);
        return row.conversionState === "converting" ? stop(row, reason, tx, valid) : { outcome: "completed" };
      });
    } finally { await cleanup(staging); }
  }, { retrySafe: true });

  const service: FilesModule = {
    init() {
      const provider: PublicApiProviders["orderFiles"] = {
        async list(orderPublicId, query, caller) {
          if (caller.kind !== "api_key" || !caller.scopes.includes("files:read")) throw forbidden("FILE_API_SCOPE_REQUIRED");
          const limit = boundedLimit(query.limit);
          const after = cursorValue(query.cursor ?? undefined);
          return currentTx(async (tx) => {
            const order = await deps.services.orders.getOrderRefByPublicId(orderPublicId, tx, { forUpdate: true });
            if (!order) return null;
            const rows = await tx.select({
              publicId: orderFiles.publicId, category: orderFiles.category, displayNameEnc: orderFiles.displayNameEnc,
              contentType: orderFiles.contentType, size: orderFiles.byteSize, version: orderFiles.version, createdAt: orderFiles.createdAt,
            }).from(orderFiles).where(and(
              eq(orderFiles.orderId, order.id), eq(orderFiles.orderPublicId, order.publicId),
              eq(orderFiles.ownerUserId, order.ownerUserId), eq(orderFiles.visibility, "customer_visible"),
              isNull(orderFiles.deletedAt), isNull(orderFiles.purgedAt), isNull(orderFiles.supersededAt),
              after ? gt(orderFiles.publicId, after) : undefined,
              query.updatedSince ? gte(orderFiles.createdAt, query.updatedSince) : undefined,
            )).orderBy(orderFiles.publicId).limit(limit + 1).for("update");
            return {
              items: rows.slice(0, limit).map((row) => ({
                id: row.publicId, orderId: order.publicId, category: row.category, contentType: row.contentType,
                displayName: crypto.decrypt(row.displayNameEnc, `order_files.display_name:${row.publicId}`),
                size: row.size, version: row.version, createdAt: row.createdAt.toISOString(),
              })),
              nextCursor: rows.length > limit ? encodeCursor(rows[limit - 1]!.publicId) : null,
            };
          });
        },
      };
      deps.services.publicApi.registerProvider("orderFiles", provider);
    },
    async health() {
      let healthy = true;
      try {
        await local.checkRoot?.();
      } catch {
        healthy = false;
      }
      const antivirus = scanner ? await scanner.health().catch(() => "failing" as const) : "not_configured";
      const enabled = (await audioRules()).enabled;
      const version = enabled ? await audioVersion() : null;
      return [
        { component: "storage.local", state: healthy ? "ok" : "failing", summary: healthy ? "Private storage is available." : "Private storage is unavailable.", checkedAt: clock.now() },
        { component: "files.antivirus", state: antivirus, summary: scanner ? "An external scanner is configured." : "External antivirus scanning is not configured.", checkedAt: clock.now() },
        { component: "files.audio", state: enabled ? version ? "ok" : "degraded" : "disabled",
          summary: version ? `FFmpeg ${version} is available for audio conversion.` : enabled ? "Audio conversion is not available." : "Audio recording and conversion are disabled.", checkedAt: clock.now() },
      ];
    },
    async beginUpload(principal, orderPublicId, options) {
      try {
        requireFull(principal);
        if (options.source === "document_edit") throw validation("DOCUMENT_EDIT_ROUTE_REQUIRED", "Use the document editor to save a new version.");
        if ((options.intent !== undefined) !== (options.stageKey !== undefined) || (options.intent && options.source)) {
          throw validation("INVALID_PHASE_UPLOAD", "Choose one approved phase upload action.");
        }
        const source = sourceFor(options);
        if (principal.role === "customer" && (options.category === "deliverable" || options.visibility === "staff_only")) {
          throw forbidden("FILE_STAFF_ONLY");
        }
        if (principal.role !== "customer") fullCapability(principal, "files.manage");
        return await currentTx(async (tx) => {
          const order = await deps.services.orders.assertCanWriteOrder(principal, orderPublicId, { kind: "file", tx, forUpdate: true });
          await requireCurrent(principal, tx);
          const stage = await resolveUploadStage(principal, order.publicId, options, tx);
          if (!stage?.governance) await deps.services.orders.assertFileStatusWritable(principal, order.publicId, order.statusKey, tx);
          if ((options.slotKey === undefined) !== (options.statusKey === undefined) ||
            (options.statusKey !== undefined && (options.statusKey !== order.statusKey ||
              (stage && stage.statusKey !== options.statusKey)))) {
            throw conflict("UPLOAD_SLOT_STATUS_CHANGED", "The upload slot no longer matches the current order status.");
          }
          if (principal.role === "customer") await deps.services.orders.gates.assertCustomerMayWork({
            tx, orderId: order.id, actor: principal, action: source === "recording" ? "record" : "upload",
            statusKey: stage?.statusKey ?? options.statusKey ?? null,
          });
          if (options.slotKey && options.visibility !== "customer_visible") throw validation("UPLOAD_SLOT_PRIVATE", "Workflow slot files must be customer-visible.");
          const slot = await resolveSlot(principal, order.publicId, order.statusKey, options.slotKey, tx);
          assertSlotCapture(slot, source);
          const [fullPolicy, audio] = await Promise.all([rules(tx), audioRules(tx)]);
          if (source === "recording" && !audio.enabled) throw forbidden("RECORDING_DISABLED");
          const effective = limitsForRequest(fullPolicy, stage, audio, options, slot);
          if (stage && effective.phaseLimits && !options.versionOf) {
            const intent = uploadIntent(options);
            if (intent !== "legacy" || slot) {
              const isAudio = intent === "recording" || intent === "prerecorded_audio" || (intent === "legacy" && slot?.kind === "audio");
              const usage = await phaseUsage(order.id, stage.stageKey, tx);
              assertPhaseRoom(effective.phaseLimits, usage, isAudio);
            }
          }
          return { ...options, ...effective,
            orderPublicId: order.publicId, orderId: order.id, ownerUserId: order.ownerUserId, statusKey: order.statusKey,
            stageKey: stage?.stageKey, requestedStageKey: options.stageKey, targetStatusKey: stage?.statusKey, slot };
        });
      } catch (error) {
        if (error instanceof DomainError && error.code !== "AUDIT_UNAVAILABLE") await orderEvent(principal, orderPublicId, error.reasonCode);
        throw error;
      }
    },
    async stageUpload(name, stream, policy) {
      const displayName = sanitizeDisplayName(name);
      if (!policy.extensions.includes(displayExtension(displayName) as FileExtension)) {
        throw validation("FILE_TYPE_DISABLED", "The file extension is not enabled for uploads.");
      }
      const key = local.newUploadKey?.() ?? storage.newKey("staging");
      try {
        const info = await storage.put(key, stream, { maxBytes: policy.maxFileBytes });
        const classification = await classifyObject(info, displayName, policy);
        const staged = { info, classification, displayName };
        await scanStaged(staged);
        return staged;
      } catch (error) {
        await cleanup(key);
        throw error;
      }
    },
    rejectUpload: orderEvent,
    cleanUpload: (staged) => cleanup(staged.info.key),
    async recordingPreflight(principal, orderPublicId, slotKey, stageKey) {
      requireFull(principal);
      if (principal.role !== "customer") fullCapability(principal, "files.manage");
      const status = await currentTx(async (tx) => {
        const order = await deps.services.orders.assertCanWriteOrder(principal, orderPublicId, { kind: "file", tx, forUpdate: true });
        await requireCurrent(principal, tx);
        const options: UploadOptions = { stageKey, slotKey, source: "recording", category: "supporting", visibility: "customer_visible" };
        const stage = await resolveUploadStage(principal, order.publicId, options, tx);
        if (!stage?.governance) await deps.services.orders.assertFileStatusWritable(principal, order.publicId, order.statusKey, tx);
        if (slotKey && stage && stage.statusKey !== order.statusKey) {
          throw conflict("UPLOAD_SLOT_STATUS_CHANGED", "The recording slot no longer matches the current phase.");
        }
        if (principal.role === "customer") await deps.services.orders.gates.assertCustomerMayWork({
          tx, orderId: order.id, actor: principal, action: "record", statusKey: stage?.statusKey ?? (slotKey ? order.statusKey : null),
        });
        const slot = await resolveSlot(principal, order.publicId, order.statusKey, slotKey, tx);
        const [policy, audio] = await Promise.all([rules(tx), audioRules(tx)]);
        const { rules: effective, phaseLimits, maxAudioSeconds } = limitsForRequest(policy, stage, audio, options, slot);
        const acceptedTypes = effective.extensions;
        const usage = stage && phaseLimits ? await phaseUsage(order.id, stage.stageKey, tx) : null;
        const remaining = usage && phaseLimits ? (usage.unverifiedAudio ? 0 :
          Math.max(0, Math.floor((phaseLimits.totalAudioMaxSeconds * 1000 - usage.audioDurationMs) / 1000))) : Infinity;
        const maxSeconds = Math.min(maxAudioSeconds ?? Infinity, audio.maxMinutes * 60, remaining);
        return {
          enabled: audio.enabled && maxSeconds > 0 && (!usage || usage.audio < phaseLimits!.audioCount) && acceptedTypes.length > 0 && slot?.capture !== "upload" &&
            slot?.acceptsUpload !== false && (!slot || slot.kind === "audio"),
          maxMinutes: Math.ceil(maxSeconds / 60), maxSeconds,
          maxBytes: Math.min(effective.maxFileBytes, effective.maxRequestBytes - 1024),
          acceptedTypes,
        };
      });
      return { ...status, conversionAvailable: status.enabled && !!await audioVersion() };
    },
    async phasePolicy(principal, orderPublicId, stageKey, intent) {
      return currentTx(async (tx) => {
        const order = await deps.services.orders.assertCanReadOrder(principal, orderPublicId, { tx, forUpdate: true });
        await requireCurrent(principal, tx);
        stageStatusKeys(await listStages(principal, orderPublicId, tx), stageKey);
        const options: UploadOptions = { stageKey, intent, category: "supporting", visibility: "customer_visible" };
        const [policy, audio] = await Promise.all([rules(tx), audioRules(tx)]);
        let stage = null;
        let disabledReason = null;
        try {
          await deps.services.orders.assertCanWriteOrder(principal, orderPublicId, { kind: "file", tx });
          if (principal.role !== "customer") fullCapability(principal, "files.manage");
          stage = await resolveUploadStage(principal, orderPublicId, options, tx);
          if (principal.role === "customer") await deps.services.orders.gates.assertCustomerMayWork({
            tx, orderId: order.id, actor: principal, action: intent === "recording" ? "record" : "upload",
            statusKey: stage?.statusKey ?? null,
          });
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          // The upload/preflight route opens the agreement dialog with explicit acceptance.
          if (error.reasonCode !== "AGREEMENT_REQUIRED") disabledReason = error.reasonCode;
        }
        const effective = limitsForRequest(policy, stage, audio, options);
        const usage = stage && effective.phaseLimits ? await phaseUsage(order.id, stage.stageKey, tx) : null;
        const limits = effective.phaseLimits;
        const remainingDocuments = limits && usage ? Math.max(0, limits.documentCount - usage.documents) : null;
        const remainingAudio = limits && usage ? Math.max(0, limits.audioCount - usage.audio) : null;
        const remainingAudioSeconds = limits && usage ? (usage.unverifiedAudio ? 0 :
          Math.max(0, Math.floor((limits.totalAudioMaxSeconds * 1000 - usage.audioDurationMs) / 1000))) : null;
        if (!disabledReason && intent === "recording" && !audio.enabled) disabledReason = "RECORDING_DISABLED";
        if (!disabledReason && !effective.rules.extensions.length) disabledReason = "FILE_TYPE_DISABLED";
        if (!disabledReason && (intent === "document" ? remainingDocuments === 0 : remainingAudio === 0 || remainingAudioSeconds === 0)) {
          disabledReason = "PHASE_CAPACITY_REACHED";
        }
        return { enabled: !disabledReason, disabledReason, policy: publicPolicy(effective.rules),
          maxSeconds: Math.min(effective.maxAudioSeconds ?? audio.maxMinutes * 60, remainingAudioSeconds ?? Infinity),
          remainingDocuments, remainingAudio, remainingAudioSeconds };
      });
    },
    async documentStatus(principal, locator) {
      return currentTx(async (tx) => {
        const row = await readFile(principal, locator.filePublicId, locator.orderPublicId, tx);
        await requireCurrent(principal, tx);
        const [edit, policy, file] = await Promise.all([documentRules(tx), rules(tx), documentOutput(row, principal, tx)]);
        const enabled = edit.enabled && policy.extensions.includes("docx");
        let maxBytes = Math.min(edit.maxBytes, policy.maxFileBytes, policy.maxRequestBytes - 1024);
        let disabledReason: string | null = null;
        let agreementPolicyPublicId: string | null = null;
        let agreementSignatureMode: "typed_name" | "checkbox" | null = null;
        try { maxBytes = (await resolveDocumentEdit(principal, locator, tx)).policy.maxFileBytes; }
        catch (error) {
          if (!(error instanceof DomainError) || !["CONFLICT", "FORBIDDEN", "VALIDATION", "LOCKED", "NOT_FOUND"].includes(error.code)) throw error;
          if (error.reasonCode === "AGREEMENT_REQUIRED") {
            const policyId = error.details?.policyPublicId;
            if (typeof policyId === "string" && publicIdShape(policyId)) agreementPolicyPublicId = policyId;
            const mode = error.details?.signatureMode;
            if (mode === "typed_name" || mode === "checkbox") agreementSignatureMode = mode;
          }
          disabledReason = error.safeMessage;
        }
        return { enabled, maxBytes, canEdit: disabledReason === null, disabledReason, agreementPolicyPublicId, agreementSignatureMode, file };
      });
    },
    async listDocumentVersions(principal, locator) {
      return currentTx(async (tx) => {
        const row = await readFile(principal, locator.filePublicId, locator.orderPublicId, tx);
        await requireCurrent(principal, tx);
        if (!isDocx(row)) throw notFound("FILE_NOT_FOUND");
        const staff = roleHasCapability(principal.role, "files.read_all");
        const visibleVersions = await tx.select({ id: orderFiles.id, previousVersionId: orderFiles.previousVersionId })
          .from(orderFiles).where(and(eq(orderFiles.logicalPublicId, row.logicalPublicId),
            eq(orderFiles.orderId, row.orderId), eq(orderFiles.ownerUserId, row.ownerUserId), isNull(orderFiles.deletedAt),
            isNull(orderFiles.purgedAt), staff ? undefined : eq(orderFiles.visibility, "customer_visible"))).limit(100);
        const sourceIds = visibleVersions.flatMap((version) => version.previousVersionId ? [version.previousVersionId] : []);
        const branchRoots = tx.select({ logicalPublicId: orderFiles.logicalPublicId }).from(orderFiles).where(and(
          inArray(orderFiles.previousVersionId, visibleVersions.map((version) => version.id)),
          eq(orderFiles.orderId, row.orderId), eq(orderFiles.ownerUserId, row.ownerUserId),
          isNull(orderFiles.deletedAt), isNull(orderFiles.purgedAt), staff ? undefined : eq(orderFiles.visibility, "customer_visible"),
        ));
        const rows = await tx.select().from(orderFiles).where(and(
          eq(orderFiles.orderId, row.orderId), eq(orderFiles.ownerUserId, row.ownerUserId), eq(orderFiles.contentType, docxMime),
          or(eq(orderFiles.logicalPublicId, row.logicalPublicId), inArray(orderFiles.logicalPublicId, branchRoots),
            sourceIds.length ? inArray(orderFiles.id, sourceIds) : undefined),
          isNull(orderFiles.deletedAt), isNull(orderFiles.purgedAt), staff ? undefined : eq(orderFiles.visibility, "customer_visible"),
        )).orderBy(orderFiles.createdAt, orderFiles.publicId).limit(100);
        return Promise.all(rows.map((version) => documentOutput(version, principal, tx)));
      });
    },
    async openDocumentForEditing(principal, locator) {
      let stream: Readable | undefined;
      try {
        return await currentTx(async (tx) => {
          const row = await readFile(principal, locator.filePublicId, locator.orderPublicId, tx);
          await requireCurrent(principal, tx);
          const [edit, policy] = await Promise.all([documentRules(tx), rules(tx)]);
          if (!edit.enabled || !policy.extensions.includes("docx")) throw forbidden("DOCUMENT_EDITING_DISABLED");
          if (!isDocx(row)) throw notFound("FILE_NOT_FOUND");
          if (row.byteSize > Math.min(edit.maxBytes, policy.maxFileBytes, policy.maxRequestBytes - 1024)) throw validation("DOCUMENT_TOO_LARGE", "This Word document exceeds the editor size limit.");
          await access(principal, "attempted", tx, row.publicId, undefined, "download", row.orderPublicId);
          stream = await readObject(row);
          return { file: await documentOutput(row, principal, tx), stream };
        });
      } catch (error) {
        stream?.destroy();
        await recordWriteDenied(principal, locator.filePublicId, "open_document", error);
        throw error;
      }
    },
    async beginEditedVersion(principal, locator) {
      try {
        return await currentTx(async (tx) => {
          const { order, options, stage, slot, effective } = await resolveDocumentEdit(principal, locator, tx);
          // A response is a new customer-visible supporting file, not a replacement for the staff source.
          return { orderId: order.id, orderPublicId: order.publicId, ownerUserId: order.ownerUserId, statusKey: order.statusKey,
            ...options, ...effective, slot, taskKey: locator.taskKey,
            stageKey: stage?.stageKey, requestedStageKey: options.stageKey, targetStatusKey: stage?.statusKey };
        });
      } catch (error) {
        if (error instanceof DomainError && error.code !== "AUDIT_UNAVAILABLE") await orderEvent(principal, locator.orderPublicId, error.reasonCode);
        throw error;
      }
    },
    async saveEditedVersion(principal, upload, staged) {
      if (upload.source !== "document_edit" || !upload.versionOf) throw validation("DOCUMENT_NOT_EDITABLE", "Choose a Word document to edit.");
      return service.commitUpload(principal, upload, staged);
    },
    async commitUpload(principal, request, staged, transcript) {
      requireFull(principal);
      if (!stagingKey.test(staged.info.key)) throw validation("INVALID_FILE_REFERENCE", "The staged file reference is invalid.");
      if (principal.role === "customer" && (request.category === "deliverable" || request.visibility === "staff_only")) {
        throw forbidden("FILE_STAFF_ONLY");
      }
      if (principal.role !== "customer") fullCapability(principal, "files.manage");
      const policy = await rules();
      const isAudio = staged.classification.mime.startsWith("audio/");
      const source = sourceFor(request);
      if (source === "recording" && !isAudio) throw validation("UPLOAD_RECORDING_TYPE", "A recording must be a supported audio file.");
      if ((request.intent === "prerecorded_audio" && !isAudio) || (request.intent === "document" &&
        !documentExtensions.some((extension) => extension === staged.classification.extension))) {
        throw validation("UPLOAD_PHASE_FILE_TYPE", "The detected file type does not match this phase action.");
      }
      const editing = request.source === "document_edit";
      if (editing && (!request.versionOf || staged.classification.mime !== docxMime || staged.classification.extension !== "docx" || transcript !== undefined)) {
        throw validation("DOCUMENT_NOT_EDITABLE", "Upload one supported Word document as the new version.");
      }
      const parsedTranscript = transcript === undefined ? undefined : transcriptSchema.safeParse(transcript);
      if (parsedTranscript && (!parsedTranscript.success || !isAudio)) throw validation("INVALID_AUDIO_TRANSCRIPT", "Supply an optional transcript only for one audio upload.");
      if (!policy.extensions.includes(staged.classification.extension as FileExtension) || staged.info.size > policy.maxFileBytes) {
        throw validation("FILE_POLICY_CHANGED", "The file no longer meets the current upload rules.");
      }
      let durationMs: number | undefined;
      const plannedSeconds = request.maxAudioSeconds ?? (request.slot?.maxMinutes ? request.slot.maxMinutes * 60 : undefined);
      if (isAudio && plannedSeconds) {
        let stream: Readable | undefined;
        try {
          if (!local.withConversionDirectory) throw new AudioConversionError("AUDIO_CONVERSION_UNAVAILABLE");
          stream = await storage.get(staged.info.key);
          const input = stream;
          durationMs = await local.withConversionDirectory((directory) => measureTaskAudio({
            binary: ffmpegBinary(), directory, input, size: staged.info.size, sha256: staged.info.sha256,
            extension: staged.classification.extension, maxMinutes: plannedSeconds / 60,
          }));
        } catch (error) {
          if (error instanceof AudioConversionError && error.reasonCode === "AUDIO_DURATION_EXCEEDED") {
            throw validation("AUDIO_DURATION_EXCEEDED", `Audio for this phase or task must be ${plannedSeconds} seconds or shorter.`);
          }
          throw validation("AUDIO_DURATION_UNVERIFIED", "The recording length could not be verified for this task. Try a different audio file or contact support.");
        } finally { stream?.destroy(); }
      }
      const storageKey = storage.newKey("files");
      let placementAttempted = false;
      try {
        return await currentTx(async (tx) => {
          const order = await deps.services.orders.assertCanWriteOrder(principal, request.orderPublicId, { kind: "file", tx, forUpdate: true });
          await requireCurrent(principal, tx);
          if (order.id !== request.orderId || order.ownerUserId !== request.ownerUserId || order.statusKey !== request.statusKey) {
            throw conflict("ORDER_ACCESS_CHANGED", "The order changed during upload. Please reload and try again.");
          }
          const stage = await resolveUploadStage(principal, order.publicId, { ...request, stageKey: request.requestedStageKey }, tx);
          if ((stage?.stageKey ?? undefined) !== request.stageKey || stage?.statusKey !== request.targetStatusKey) {
            throw conflict("STAGE_CHANGED", "The phase changed during upload. Please reload and try again.");
          }
          if (!stage?.governance) await deps.services.orders.assertFileStatusWritable(principal, order.publicId, order.statusKey, tx);
          if (principal.role === "customer" && !editing) await deps.services.orders.gates.assertCustomerMayWork({
            tx, orderId: order.id, actor: principal, action: source === "recording" ? "record" : "upload",
            statusKey: stage?.statusKey ?? (request.slotKey ? order.statusKey : null),
          });
          const edit = editing ? await resolveDocumentEdit(principal, {
            orderPublicId: order.publicId, filePublicId: request.versionOf!, taskKey: request.taskKey,
          }, tx) : undefined;
          if (edit && (staged.info.size > edit.policy.maxFileBytes ||
              (edit.slot?.key ?? edit.row.slotKey ?? undefined) !== request.slotKey)) {
            throw conflict("DOCUMENT_EDIT_RULES_CHANGED", "The document editing rules changed. Reload the order and try again.");
          }
          const previous = edit?.row ?? (request.versionOf ? await findFile(request.versionOf, tx, true) : undefined);
          if (previous) {
            if (previous.orderId !== order.id || previous.orderPublicId !== order.publicId) throw notFound("FILE_NOT_FOUND");
            enforceVisibility(previous, principal, order.ownerUserId);
            if (previous.supersededAt) throw conflict("FILE_VERSION_CHANGED", "This file already has a newer version.");
            if (previous.stageKey !== (stage?.stageKey ?? null) && !(edit?.replyBranch && !previous.stageKey)) {
              throw validation("FILE_VERSION_SCOPE", "A new version must preserve its original phase.");
            }
            if ((edit?.replyBranch ? "supporting" : previous.category) !== request.category || previous.visibility !== request.visibility) {
              throw validation("FILE_VERSION_SCOPE", "A new version must preserve its file category and visibility.");
            }
            if (!edit && (previous.derivedFromPublicId || (previous.slotKey ?? undefined) !== request.slotKey ||
                (previous.slotKey && previous.statusKey !== order.statusKey))) {
              throw validation("FILE_VERSION_SCOPE", "A new version must preserve its original workflow slot.");
            }
            if (!stage && previous.statusKey && previous.statusKey !== order.statusKey) {
              await deps.services.orders.assertFileStatusWritable(principal, order.publicId, previous.statusKey, tx);
            }
          }
          const slot = editing ? edit?.slot : await resolveSlot(principal, order.publicId, order.statusKey, request.slotKey, tx);
          if (!editing || principal.role === "customer") assertSlotCapture(slot, source);
          if (slot?.maxMinutes && (durationMs === undefined || durationMs > slot.maxMinutes * 60_000 + 25)) {
            throw validation("AUDIO_DURATION_EXCEEDED", `Audio for this task must be ${slot.maxMinutes} minutes or shorter.`);
          }
          const [currentPolicy, audio] = await Promise.all([rules(tx), audioRules(tx)]);
          const effective = limitsForRequest(currentPolicy, stage, audio, request, slot);
          if (!effective.rules.extensions.some((extension) => extension === staged.classification.extension) ||
              staged.info.size > effective.rules.maxFileBytes || (previous && !!previous.stageKey &&
                previous.contentType.startsWith("audio/") !== isAudio)) {
            throw validation("FILE_POLICY_CHANGED", "The file no longer meets the current upload rules.");
          }
          if (stage && effective.phaseLimits) {
            if (isAudio && effective.maxAudioSeconds !== undefined && (durationMs === undefined || durationMs > effective.maxAudioSeconds * 1000)) {
              throw validation("AUDIO_DURATION_EXCEEDED", "This file exceeds the phase audio duration limit.");
            }
            const usage = await phaseUsage(order.id, stage.stageKey, tx, edit?.replyBranch ? undefined : previous?.id);
            verifyPhaseCapacity(effective.phaseLimits, usage, isAudio, staged.info.size, durationMs);
          }
          if (slot) {
            if (request.visibility !== "customer_visible" || !slotAllows(slot, staged.classification)) {
              throw validation("UPLOAD_SLOT_FILE_TYPE", "This file type or visibility does not meet the workflow slot requirements.");
            }
            if (!previous && await countFilesInSlot(order.id, slot.key, tx, { statusKey: order.statusKey }) >= slot.maxCount) throw slotRoomError();
          }
          if (source === "recording" && !audio.enabled) throw forbidden("RECORDING_DISABLED");
          const needsConversion = isAudio && (staged.classification.mime !== "audio/webm" || staged.classification.requiresReencode === true);
          const convert = needsConversion && audio.enabled;
          const file = await insertVersion(tx, principal, { ...request, source, statusKey: previous?.statusKey ?? stage?.statusKey ?? request.statusKey,
            staged, storageKey, previous, phasePublicId: previous?.phasePublicId,
            transcript: parsedTranscript?.data, convertAudio: convert, conversionDisabled: needsConversion && !convert,
            durationMs, replyBranch: edit?.replyBranch });
          placementAttempted = true;
          await storage.move(staged.info.key, storageKey);
          if (!convert) await deps.services.storageConnections?.stageOrderFile(file.publicId, tx, { orderPublicId: order.publicId });
          if (convert) {
            if (stage && effective.phaseLimits) await deps.services.storageConnections?.stageOrderFile(file.publicId, tx,
              { orderPublicId: order.publicId, managedOnly: true });
            const jobMinutes = effective.maxAudioSeconds ? Math.ceil(effective.maxAudioSeconds / 60) : slot?.maxMinutes;
            await deps.jobs.enqueue(audioJob, { filePublicId: file.publicId, ...(jobMinutes ? { taskMaxMinutes: jobMinutes } : {}) }, {
              maxAttempts: maxAudioJobAttempts, idempotencyKey: `file-audio:${file.publicId}`, correlationId: getRequestContext()?.correlationId,
            }, tx);
          }
          return file;
        });
      } catch (error) {
        if (placementAttempted) {
          // The client could lose the MySQL COMMIT acknowledgement. Never delete committed data on an
          // uncertain outcome; leave it for operator reconciliation if the authoritative check fails.
          const committed = await db.select({ id: orderFiles.id }).from(orderFiles).where(eq(orderFiles.storageKey, storageKey)).limit(1)
            .then((rows) => rows.length > 0).catch(() => undefined);
          if (committed === false) await cleanup(storageKey);
          else if (committed === undefined) logger.warn("Private file publication outcome requires reconciliation");
        }
        throw error;
      }
    },
    async list(principal, orderPublicId, options) {
      return currentTx(async (tx) => {
        const page = await getPage(principal, orderPublicId, options, tx);
        const [slots, policy, audio] = page.canUpload ? await Promise.all([
          deps.services.orders.getFileUploadSlots(principal, orderPublicId, tx), rules(tx), audioRules(tx),
        ]) : [null, null, null];
        return { ...page, uploadSlots: slots ?? null, uploadPolicy: policy ? publicPolicy(policy) : null,
          audio: audio ? { enabled: audio.enabled, maxMinutes: audio.maxMinutes } : null };
      });
    },
    async teamFiles(principal, orderPublicId, stageKey, cursor) {
      return currentTx(async (tx) => {
        const { rows, stages, nextCursor } = await selectDeliverables(principal, { orderPublicId, stageKey, after: cursor, team: true }, tx);
        return { items: rows.map((row) => deliverableOutput(row, stages)), nextCursor };
      });
    },
    async listDeliverableFiles(principal, scope, tx) {
      const run = async (executor: Tx) => {
        const { rows, stages, nextCursor } = await selectDeliverables(principal, scope, executor);
        return { items: rows.map((row) => deliverableOutput(row, stages)), nextCursor };
      };
      return tx ? run(tx) : currentTx(run);
    },
    async openDeliverableFile(principal, scope, tx) {
      let stream: Readable | undefined;
      const run = async (executor: Tx) => {
        const { rows: [row], stages } = await selectDeliverables(principal, { ...scope, limit: 1 }, executor);
        if (!row) throw notFound("FILE_NOT_FOUND");
        await access(principal, "attempted", executor, row.publicId, undefined, "deliverable", row.orderPublicId,
          row.stageKey ? { stage_key: row.stageKey } : undefined);
        stream = await readObject(row);
        return { file: deliverableOutput(row, stages), stream };
      };
      try { return await (tx ? run(tx) : currentTx(run)); }
      catch (error) { stream?.destroy(); throw error; }
    },
    countFilesInSlot,
    async readTranscript(principal, filePublicId) {
      return currentTx(async (tx) => {
        const row = await readFile(principal, filePublicId, undefined, tx);
        await audit.record(event(principal, "file.audio.transcript.viewed", "view", "completed", filePublicId), tx);
        return { transcript: row.transcriptEnc ? crypto.decrypt(row.transcriptEnc, `order_files.transcript:${row.publicId}`) : null };
      });
    },
    async enumerateOrderFiles(principal, orderPublicId, options = {}) {
      const { items, nextCursor } = await service.list(principal, orderPublicId, { ...options, includeDeleted: false });
      return { items, nextCursor };
    },
    async assertCanReadFile(principal, filePublicId, orderPublicId) {
      return output(await currentTx((tx) => readFile(principal, filePublicId, orderPublicId, tx)));
    },
    async openForExport(principal, filePublicId, orderPublicId, callerTx) {
      fullCapability(principal, "portable.export");
      let stream: Readable | undefined;
      try {
        const open = async (tx: Tx) => {
          const row = await readFile(principal, filePublicId, orderPublicId, tx);
          await audit.record(event(principal, "file.export.open", "export", "attempted", filePublicId), tx);
          const file = output(row);
          stream = await readObject(row);
          return { file, stream };
        };
        return await (callerTx ? open(callerTx) : currentTx(open));
      } catch (error) {
        stream?.destroy();
        throw error;
      }
    },
    async issueDownloadTicket(principal, filePublicId) {
      try {
        return await currentTx(async (tx) => {
          const row = await readFile(principal, filePublicId, undefined, tx);
          await requireCurrent(principal, tx);
          const ticket = randomToken();
          const now = clock.now();
          const expiresAt = new Date(now.getTime() + ticketLifetimeMs);
          await tx.insert(fileDownloadTickets).values({
            tokenHash: crypto.hashToken(ticket), orderId: row.orderId, fileId: row.id, userId: principal.userId, sessionId: principal.sessionId,
            issuedAt: now, expiresAt,
          });
          await audit.record(event(principal, "file.download.ticket_issued", "create", "completed", row.publicId), tx);
          return { ticket, expiresAt };
        });
      } catch (error) {
        if (error instanceof DomainError && ["NOT_FOUND", "FORBIDDEN", "UNAUTHENTICATED", "REMEDIATION_REQUIRED"].includes(error.code)) {
          await service.recordDownloadDenied(principal, error.reasonCode);
        }
        throw error;
      }
    },
    async redeemDownloadTicket(principal, ticket) {
      let stream: Readable | undefined;
      try {
        requireFull(principal);
        if (!tokenShape.test(ticket) || ticket.length !== 43) throw notFound("DOWNLOAD_TICKET_INVALID");
        const ticketHash = crypto.hashToken(ticket);
        return await currentTx(async (tx) => {
          const [candidate] = await tx.select().from(fileDownloadTickets).where(eq(fileDownloadTickets.tokenHash, ticketHash)).limit(1);
          if (!candidate || candidate.userId !== principal.userId || candidate.sessionId !== principal.sessionId || candidate.expiresAt <= clock.now()) {
            throw notFound("DOWNLOAD_TICKET_INVALID");
          }
          // Order row before ticket row: matches the reassignment/revoke lock order.
          const order = await deps.services.orders.assertCanReadOrderById(principal, candidate.orderId, { tx, forUpdate: true });
          await requireCurrent(principal, tx);
          const [current] = await tx.select().from(fileDownloadTickets).where(eq(fileDownloadTickets.id, candidate.id)).limit(1).for("update");
          if (!current || current.userId !== principal.userId || current.sessionId !== principal.sessionId || current.expiresAt <= clock.now()) {
            throw notFound("DOWNLOAD_TICKET_INVALID");
          }
          const [row] = await tx.select().from(orderFiles).where(eq(orderFiles.id, current.fileId)).limit(1).for("update");
          if (!row || row.orderId !== order.id || row.orderPublicId !== order.publicId) throw notFound("FILE_NOT_FOUND");
          enforceVisibility(row, principal, order.ownerUserId);
          await requireStageRead(principal, row, tx);
          const file = output(row);
          await access(principal, "attempted", tx, row.publicId, undefined, "download", row.orderPublicId);
          await tx.delete(fileDownloadTickets).where(eq(fileDownloadTickets.id, current.id));
          stream = await readObject(row);
          return { file, stream };
        });
      } catch (error) {
        stream?.destroy();
        if (error instanceof DomainError && ["NOT_FOUND", "FORBIDDEN", "UNAUTHENTICATED", "REMEDIATION_REQUIRED"].includes(error.code)) {
          await service.recordDownloadDenied(principal, error.reasonCode);
          throw notFound("DOWNLOAD_TICKET_INVALID");
        }
        if (error instanceof DomainError && error.reasonCode === "FILE_BYTES_UNAVAILABLE") {
          await db.transaction((tx) => access(principal, "failed", tx, undefined, "FILE_BYTES_UNAVAILABLE"));
        }
        throw error;
      }
    },
    async issuePlaybackTicket(principal, orderPublicId, filePublicId) {
      try {
        return await currentTx(async (tx) => {
          const row = await readFile(principal, filePublicId, orderPublicId, tx);
          await requireCurrent(principal, tx);
          assertPlayable(row);
          const ticket = randomToken();
          const now = clock.now();
          await tx.insert(filePlaybackGrants).values({
            publicId: ulid(now.getTime()), tokenHash: crypto.hashToken(ticket), orderId: row.orderId, fileId: row.id,
            userId: principal.userId, sessionId: principal.sessionId, issuedAt: now, expiresAt: new Date(now.getTime() + ticketLifetimeMs),
          });
          await audit.record({ ...event(principal, "file.playback.ticket_issued", "create", "completed", row.publicId), orderPublicId,
            ...(row.stageKey ? { attributes: { stage_key: row.stageKey } } : {}) }, tx);
          return { ticket };
        });
      } catch (error) {
        if (error instanceof DomainError && ["NOT_FOUND", "FORBIDDEN", "UNAUTHENTICATED", "REMEDIATION_REQUIRED"].includes(error.code)) {
          await service.recordPlaybackAccess(principal, "denied", undefined, "PLAYBACK_NOT_AVAILABLE");
          throw notFound("PLAYBACK_NOT_AVAILABLE");
        }
        throw error;
      }
    },
    redeemPlaybackTicket(principal, ticket) {
      return withPlayback(principal, ticket, undefined, async (row, grant, tx) => {
        const secret = randomToken();
        const now = clock.now();
        await tx.update(filePlaybackGrants).set({ tokenHash: crypto.hashToken(secret), redeemedAt: now,
          expiresAt: new Date(now.getTime() + playbackLifetimeMs) }).where(eq(filePlaybackGrants.id, grant.id));
        await audit.record({ ...event(principal, "file.playback.grant_started", "create", "completed", row.publicId), orderPublicId: row.orderPublicId,
          ...(row.stageKey ? { attributes: { stage_key: row.stageKey } } : {}) }, tx);
        return { grantPublicId: grant.publicId, secret };
      });
    },
    async openPlayback(principal, grantPublicId, secret, header, head) {
      let stream: Readable | undefined;
      let authorizedFile: FileRecord | undefined;
      try {
        return await withPlayback(principal, secret, grantPublicId, async (row, _grant, tx) => {
          const range = parseAudioRange(head ? undefined : header, row.byteSize);
          const file = output(row);
          authorizedFile = file;
          await access(principal, range === "unsatisfiable" ? "denied" : "attempted", tx, row.publicId,
            range === "unsatisfiable" ? "PLAYBACK_RANGE_INVALID" : undefined, "playback", row.orderPublicId,
            row.stageKey ? { stage_key: row.stageKey } : undefined);
          if (range !== "unsatisfiable" && !head) {
            stream = await storage.get(row.storageKey, range ?? undefined).catch(() => {
              throw new DomainError("UNAVAILABLE", "FILE_BYTES_UNAVAILABLE", "The private file is unavailable.");
            });
          }
          return { file, range, stream };
        });
      } catch (error) {
        stream?.destroy();
        if (error instanceof DomainError && error.reasonCode === "FILE_BYTES_UNAVAILABLE") {
          await service.recordPlaybackAccess(principal, "failed", authorizedFile, error.reasonCode);
        }
        throw error;
      }
    },
    recordPlaybackAccess: (principal, outcome, file, reason, bytesSent) =>
      currentTx((tx) => access(principal, outcome, tx, file?.publicId, reason, "playback", file?.orderPublicId, {
        ...(file?.stageKey ? { stage_key: file.stageKey } : {}),
        ...(bytesSent !== undefined ? { bytes_sent: bytesSent } : {}),
      })),
    recordDownloadDenied: (principal, reason) => db.transaction((tx) => access(principal, "denied", tx, undefined, reason)),
    recordDownloadResult: (principal, publicId, outcome) => db.transaction(async (tx) => {
      const [file] = await tx.select({ orderPublicId: orderFiles.orderPublicId }).from(orderFiles).where(eq(orderFiles.publicId, publicId)).limit(1);
      await access(principal, outcome, tx, publicId, undefined, "download", file?.orderPublicId);
    }),
    setVisibility: (principal, publicId, visibility) => writeFile(principal, publicId, { visibility }),
    remove: (principal, publicId) => writeFile(principal, publicId, "delete"),
    restore: (principal, publicId) => writeFile(principal, publicId, "restore"),
    async adminOverview(principal) {
      requireFull(principal);
      if (principal.role !== "admin") throw forbidden("CAPABILITY_NOT_GRANTED");
      const [row] = await db.select({
        storedFiles: count(orderFiles.id),
        storedBytes: sql<string>`COALESCE(SUM(${orderFiles.byteSize}), 0)`,
        retainedFiles: sql<number>`COALESCE(SUM(${orderFiles.deletedAt} IS NOT NULL), 0)`,
      }).from(orderFiles).where(isNull(orderFiles.purgedAt));
      const conversion = await audioRules();
      return { rules: await rules(), audioRules: conversion, audioVersion: conversion.enabled ? await audioVersion() : null,
        documentEditingRules: await documentRules(),
        storedFiles: row?.storedFiles ?? 0, storedBytes: String(row?.storedBytes ?? 0),
        retainedFiles: Number(row?.retainedFiles ?? 0), antivirus: scanner ? "configured" : "not_configured",
        supported: { extensions: [...allowedExtensions], maxFileBytes: hardMaxFileBytes, maxRequestBytes: hardMaxRequestBytes, maxFiles: hardMaxFiles } };
    },
    async setTypeRules(principal, value) {
      fullCapability(principal, "platform.settings.manage", true);
      if (principal.role !== "admin") throw forbidden("CAPABILITY_NOT_GRANTED");
      return currentTx(async (tx) => {
        const current = await requireCurrent(principal, tx);
        fullCapability({ ...principal, role: current.role, stepUpAt: current.stepUpAt }, "platform.settings.manage", true);
        if (current.role !== "admin") throw forbidden("CAPABILITY_NOT_GRANTED");
        await writeSetting(settings, fileRulesSetting, value, tx);
        await audit.record(event(principal, "file.rules.changed", "update", "completed"), tx);
        return value;
      });
    },
    async setAudioRules(principal, value) {
      fullCapability(principal, "platform.settings.manage", true);
      if (principal.role !== "admin") throw forbidden("CAPABILITY_NOT_GRANTED");
      const checked = audioRulesSchema.safeParse(value);
      if (!checked.success) throw validation("INVALID_AUDIO_RULES", "Choose valid audio limits. The original must be retained.");
      return currentTx(async (tx) => {
        const current = await requireCurrent(principal, tx);
        fullCapability({ ...principal, role: current.role, stepUpAt: current.stepUpAt }, "platform.settings.manage", true);
        if (current.role !== "admin") throw forbidden("CAPABILITY_NOT_GRANTED");
        await writeSetting(settings, audioRulesSetting, checked.data, tx);
        await audit.record({ ...event(principal, "file.audio.rules.changed", "update", "completed"),
          attributes: { enabled: checked.data.enabled, max_minutes: checked.data.maxMinutes, bitrate_kbps: checked.data.bitrateKbps } }, tx);
        return checked.data;
      });
    },
    async setDocumentEditingRules(principal, value) {
      fullCapability(principal, "platform.settings.manage", true);
      if (principal.role !== "admin") throw forbidden("CAPABILITY_NOT_GRANTED");
      const checked = documentEditingRulesSchema.safeParse(value);
      if (!checked.success) throw validation("INVALID_DOCUMENT_EDITING_RULES", "Choose a valid Word editor size limit.");
      return currentTx(async (tx) => {
        const current = await requireCurrent(principal, tx);
        fullCapability({ ...principal, role: current.role, stepUpAt: current.stepUpAt }, "platform.settings.manage", true);
        if (current.role !== "admin") throw forbidden("CAPABILITY_NOT_GRANTED");
        await writeSetting(settings, documentEditingSetting, checked.data, tx);
        await audit.record({ ...event(principal, "file.document.rules.changed", "update", "completed"),
          attributes: { enabled: checked.data.enabled, max_bytes: checked.data.maxBytes } }, tx);
        return checked.data;
      });
    },
    async revokeTicketsForOrder(orderId, tx = undefined) {
      await (tx ?? db).delete(fileDownloadTickets).where(eq(fileDownloadTickets.orderId, orderId));
      await (tx ?? db).delete(filePlaybackGrants).where(eq(filePlaybackGrants.orderId, orderId));
    },
    async reassignOrderFiles(orderId, ownerUserId, tx) {
      await tx.update(orderFiles).set({ ownerUserId }).where(eq(orderFiles.orderId, orderId));
      await service.revokeTicketsForOrder(orderId, tx);
    },
    async validatePortableObject(input, tx) {
      const { classification } = await validatePortable(input, tx);
      return { extension: classification.extension, contentType: classification.mime };
    },
    async adoptVerifiedObject(input, tx) {
      fullCapability(input.principal, "portable.import", true);
      if (!filesKey.test(input.destinationKey) || (input.publicId !== undefined && !publicIdShape(input.publicId)) ||
          (input.phasePublicId !== undefined && input.phasePublicId !== null)) {
        throw validation("INVALID_FILE_REFERENCE", "The imported file reference is invalid.");
      }
      if (input.createdAt && (!Number.isFinite(input.createdAt.getTime()) || input.createdAt.getUTCFullYear() < 1000 || input.createdAt.getUTCFullYear() >= 9999)) {
        throw validation("INVALID_FILE_DATE", "The imported file timestamp is invalid.");
      }
      const order = await deps.services.orders.assertCanReadOrderById(input.principal, input.orderId, { tx, forUpdate: true });
      if (order.publicId !== input.orderPublicId || order.ownerUserId !== input.ownerUserId || order.origin !== "import") {
        throw notFound("ORDER_NOT_FOUND");
      }
      const staged = await validatePortable(input, tx);
      await scanStaged(staged);
      const file = await insertVersion(tx, input.principal, {
        ...input, staged, storageKey: input.destinationKey, statusKey: order.statusKey, imported: true,
      });
      await storage.move(input.stagedObject.key, input.destinationKey);
      return file;
    },
    async portableFiles(tx, options) {
      fullCapability(options.principal, "portable.export");
      const limit = boundedLimit(options.limit);
      if (options.orderIds?.length === 0) return { items: [], nextCursor: null };
      if (options.orderIds && options.orderIds.length > 500) throw validation("INVALID_FILE_SELECTION", "Select fewer orders at a time.");
      const after = cursorValue(options.after);
      const rows = await tx.select().from(orderFiles).where(and(
        options.orderIds ? inArray(orderFiles.orderId, [...options.orderIds]) : undefined,
        after ? gt(orderFiles.publicId, after) : undefined,
        isNull(orderFiles.deletedAt), isNull(orderFiles.supersededAt), isNull(orderFiles.purgedAt),
      )).orderBy(orderFiles.publicId).limit(limit + 1);
      const items: PortableStoredFile[] = [];
      for (const row of rows.slice(0, limit)) {
        const order = await deps.services.orders.assertCanReadOrderById(options.principal, row.orderId, { tx });
        enforceVisibility(row, options.principal, order.ownerUserId);
        if (row.orderPublicId !== order.publicId) throw notFound("FILE_NOT_FOUND");
        items.push({ ...output(row), storageKey: row.storageKey, orderId: order.id, ownerUserId: order.ownerUserId, ownerPublicId: order.ownerPublicId });
      }
      return { items, nextCursor: rows.length > limit ? encodeCursor(rows[limit - 1]!.publicId) : null };
    },
    async backupFiles(tx, options) {
      const limit = boundedLimit(options.limit);
      const after = cursorValue(options.after);
      const rows = await tx.select().from(orderFiles).where(and(
        after ? gt(orderFiles.publicId, after) : undefined, isNull(orderFiles.purgedAt),
      )).orderBy(orderFiles.publicId).limit(limit + 1);
      return {
        items: rows.slice(0, limit).map((row) => ({ ...output(row), storageKey: row.storageKey })),
        nextCursor: rows.length > limit ? encodeCursor(rows[limit - 1]!.publicId) : null,
      };
    },
    async getOrderFileCopySource(filePublicId, tx) {
      const unavailable = () => notFound("STORAGE_COPY_SOURCE_INACTIVE");
      const findSource = (lock: boolean) => findFile(filePublicId, tx, lock).catch((error: unknown) => {
        if (error instanceof DomainError && error.code === "NOT_FOUND") throw unavailable();
        throw error;
      });
      const initial = await findSource(false);
      const order = await deps.services.orders.getOrderRefById(initial.orderId, tx, { forUpdate: true });
      if (!order || order.lockState !== "none") throw unavailable();
      const owner = await deps.services.identity.getUser(order.ownerUserId, { tx, forUpdate: true });
      const row = await findSource(true);
      if (!owner || owner.status !== "active" || row.orderId !== order.id || row.orderPublicId !== order.publicId ||
          row.ownerUserId !== owner.id || row.deletedAt || row.purgedAt) throw unavailable();
      return {
        storageKey: row.storageKey, size: row.byteSize, sha256: row.sha256, contentType: row.contentType,
        displayName: copyDisplayName(row), extension: row.extension, visibility: row.visibility,
        currentVersion: row.supersededAt === null, ownerUserId: owner.id,
        customerName: owner.name, customerReference: owner.customerRef ?? owner.publicId,
        customerPublicId: owner.publicId, orderReference: order.reference, orderPublicId: order.publicId, orderName: order.name,
        filePublicId: row.publicId, statusKey: row.statusKey, slotKey: row.slotKey, stageKey: row.stageKey,
        derivative: row.derivedFromPublicId !== null, conversionState: row.conversionState, createdAt: row.createdAt,
      };
    },
    async listOrderFileCopyMetadata(orderPublicId, filePublicIds, tx) {
      if (filePublicIds.length > 100 || !filePublicIds.every(publicIdShape)) {
        throw validation("FILE_COPY_METADATA_INPUT", "Provide up to 100 valid file references.");
      }
      if (!filePublicIds.length) return [];
      const order = await deps.services.orders.getOrderRefByPublicId(orderPublicId, tx);
      if (!order) return [];
      const owner = await deps.services.identity.getUser(order.ownerUserId, { tx });
      const canCopy = owner?.status === "active" && order.lockState === "none";
      const rows = await tx.select({
        publicId: orderFiles.publicId, displayNameEnc: orderFiles.displayNameEnc, statusKey: orderFiles.statusKey, stageKey: orderFiles.stageKey,
        slotKey: orderFiles.slotKey, deletedAt: orderFiles.deletedAt, purgedAt: orderFiles.purgedAt,
        conversionState: orderFiles.conversionState, extension: orderFiles.extension, contentType: orderFiles.contentType,
      }).from(orderFiles).where(and(eq(orderFiles.orderId, order.id), eq(orderFiles.orderPublicId, order.publicId),
        eq(orderFiles.ownerUserId, order.ownerUserId), inArray(orderFiles.publicId, [...new Set(filePublicIds)])));
      return rows.map((row) => ({
        filePublicId: row.publicId, displayName: copyDisplayName(row),
        statusKey: row.statusKey, slotKey: row.slotKey, stageKey: row.stageKey, sourceAvailable: canCopy && !row.deletedAt && !row.purgedAt,
      }));
    },
    async listOrderFileCopyCandidates(orderPublicId, tx, filePublicId) {
      const order = await deps.services.orders.getOrderRefByPublicId(orderPublicId, tx, { forUpdate: true });
      if (!order || order.lockState !== "none") return null;
      const owner = await deps.services.identity.getUser(order.ownerUserId, { tx, forUpdate: true });
      if (!owner || owner.status !== "active") return null;
      const scope = and(eq(orderFiles.orderId, order.id), eq(orderFiles.orderPublicId, order.publicId),
        eq(orderFiles.ownerUserId, order.ownerUserId), isNull(orderFiles.deletedAt), isNull(orderFiles.purgedAt),
        eq(orderFiles.visibility, "customer_visible"), isNull(orderFiles.supersededAt));
      if (filePublicId) {
        const [file] = await tx.select({ state: orderFiles.conversionState, reason: orderFiles.conversionReason }).from(orderFiles)
          .where(and(scope, eq(orderFiles.publicId, filePublicId))).limit(1);
        if (!file) return null;
        if (file.state === "converting") return []; // The conversion worker stages the first copy.
        if (file.reason === "AUDIO_SOURCE_INTEGRITY" || file.reason === "FILE_BYTES_UNAVAILABLE") return null;
        if (file.state !== "converted") return [filePublicId];
        const [derivative] = await tx.select({ publicId: orderFiles.publicId }).from(orderFiles)
          .where(and(scope, eq(orderFiles.derivedFromPublicId, filePublicId))).limit(1);
        return derivative ? [derivative.publicId] : null;
      }
      const rows = await tx.select({ publicId: orderFiles.publicId }).from(orderFiles)
        .where(and(scope, sql`(${orderFiles.conversionState} IS NULL OR ${orderFiles.conversionState} = 'failed')`,
          sql`(${orderFiles.conversionReason} IS NULL OR ${orderFiles.conversionReason} NOT IN ('AUDIO_SOURCE_INTEGRITY', 'FILE_BYTES_UNAVAILABLE'))`))
        .orderBy(orderFiles.publicId).limit(51);
      return rows.map(({ publicId }) => publicId);
    },
    async getUploadAutomationContext(filePublicId, handle) {
      if (!publicIdShape(filePublicId)) return null;
      const [row] = await handle.select({
        orderPublicId: orderFiles.orderPublicId, orderOwnerUserId: orderFiles.ownerUserId, category: orderFiles.category,
      }).from(orderFiles).where(and(eq(orderFiles.publicId, filePublicId), isNull(orderFiles.deletedAt),
        isNull(orderFiles.purgedAt), isNull(orderFiles.supersededAt), eq(orderFiles.visibility, "customer_visible"))).limit(1);
      return row ?? null;
    },
  };
  return service;
}
