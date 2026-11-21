import type { Readable } from "node:stream";
import type { z } from "zod";
import type { DbOrTx, ModuleLifecycle, SessionPrincipal, Tx } from "../../core/types.js";
import type { CopyLogService } from "./copyLog.js";

export const STORAGE_PROVIDER_KINDS = ["s3", "azure_blob", "dropbox", "google_drive", "sharepoint", "onedrive"] as const;
export type StorageProviderKind = (typeof STORAGE_PROVIDER_KINDS)[number];
export const STORAGE_PURPOSES = ["order_files", "backups", "order_data"] as const;
export type StoragePurpose = (typeof STORAGE_PURPOSES)[number];

export interface StoragePutInput {
  path: readonly string[];
  name: string;
  size: number;
  /** Lowercase hex SHA-256 of the source bytes. */
  sha256: string;
  contentType: string;
  body: Readable;
  signal?: AbortSignal;
  /** Call before each externally visible write, including upload session commits. */
  beforeWrite?: () => Promise<void>;
}

export interface StoragePutResult {
  remoteId: string;
  /** A byte count independently observed by the provider, not echoed from the request. */
  size: number;
  /** Provider-reported SHA-256 only; unset when unavailable. Never return ETAG, MD5 or a request echo here. */
  sha256?: string;
  /** Other provider-generated transport checksums verified by the adapter; not equivalent to SHA-256. */
  verifiedTransportDigest?: "md5" | "quickxor";
}

export type StorageTestCode = "OK" | "NOT_CONFIGURED" | "AUTH_FAILED" | "DESTINATION_NOT_FOUND" |
  "DESTINATION_DENIED" | "EGRESS_DENIED" | "RATE_LIMITED" | "PROVIDER_UNAVAILABLE";
export interface StorageTestResult {
  ok: boolean;
  code: StorageTestCode;
}

export type StorageAdapterErrorCode = Exclude<StorageTestCode, "OK"> | "DESTINATION_CONFLICT" |
  "INTEGRITY_MISMATCH" | "INVALID_INPUT" | "TOO_LARGE" | "OUTCOME_UNKNOWN";
/** Use fixed codes only. Retryable means a retry cannot duplicate the prior external effect. */
export class StorageAdapterError extends Error {
  constructor(readonly code: StorageAdapterErrorCode, readonly retryable = false) {
    super(code);
    this.name = "StorageAdapterError";
  }
}

export interface StorageAdapter {
  test(signal?: AbortSignal): Promise<StorageTestResult>;
  ensureFolder(path: readonly string[], signal?: AbortSignal, beforeWrite?: () => Promise<void>): Promise<void>;
  put(input: StoragePutInput): Promise<StoragePutResult>;
  /** Explicit removal only. Never called by an automatic copy, retry, retention or assignment change. */
  remove(remoteId: string, signal?: AbortSignal): Promise<void>;
}

export type StorageConfig = Record<string, string | number | boolean>;
export type StorageCredentials = Record<string, string>;

export interface StorageAdapterDefinition<C extends StorageConfig = StorageConfig, S extends StorageCredentials = StorageCredentials> {
  /** Strict Zod objects: reject unknown keys and validate shape/length. Config is shown to administrators. */
  configSchema: z.ZodType<C>;
  credentialsSchema: z.ZodType<S>;
  purposes: readonly StoragePurpose[];
  create(input: { publicId: string; config: C; credentials: S }): StorageAdapter;
}

export interface StorageConnectionView {
  publicId: string;
  kind: StorageProviderKind;
  name: string;
  config: StorageConfig;
  credentialsConfigured: boolean;
  oauthConnected: boolean;
  enabled: boolean;
  version: number;
  lastTest: (StorageTestResult & { checkedAt: Date }) | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StorageAssignmentView {
  purpose: StoragePurpose;
  connectionPublicId: string;
}

export interface StorageAssignedDestination extends StorageAssignmentView {
  destinationVersion: number;
  kind: StorageProviderKind;
  name: string;
}

export interface StorageConnectionCreate {
  kind: StorageProviderKind;
  name: string;
  config: StorageConfig;
  credentials?: StorageCredentials;
}

export interface StorageConnectionUpdate {
  publicId: string;
  expectedVersion: number;
  name?: string;
  config?: StorageConfig;
  /** Omit to keep; null to clear. Otherwise replace the full credential object. */
  credentials?: StorageCredentials | null;
  enabled?: boolean;
}

export interface StorageCopyInput extends StoragePutInput {
  purpose: StoragePurpose;
  connectionPublicId: string;
  correlationId?: string;
  /** Optional destination revision from a previously materialized copy record. */
  expectedDestinationVersion?: number;
  /** Worker lease fence, rechecked before outbound writes; called with tx during durable checks. */
  assertStillOwned: (tx?: Tx) => Promise<void>;
  /** Live source-scope check before each outbound stage. */
  assertSourceCurrent?: (tx: Tx) => Promise<void>;
}

export interface StorageModule extends ModuleLifecycle {
  copies: CopyLogService;
  registerAdapter<C extends StorageConfig, S extends StorageCredentials>(
    kind: StorageProviderKind, definition: StorageAdapterDefinition<C, S>,
  ): void;
  connections: {
    list(principal: SessionPrincipal, input: { cursor?: string; limit?: number }): Promise<{
      items: StorageConnectionView[]; nextCursor: string | null;
    }>;
    get(principal: SessionPrincipal, input: { publicId: string }): Promise<StorageConnectionView>;
    create(principal: SessionPrincipal, input: StorageConnectionCreate): Promise<StorageConnectionView>;
    update(principal: SessionPrincipal, input: StorageConnectionUpdate, tx?: Tx): Promise<StorageConnectionView>;
    test(principal: SessionPrincipal, input: { publicId: string; expectedVersion: number }): Promise<StorageConnectionView>;
  };
  assignments: {
    list(principal: SessionPrincipal): Promise<StorageAssignmentView[]>;
    set(principal: SessionPrincipal, input: { purpose: StoragePurpose; connectionPublicIds: string[] }): Promise<StorageAssignmentView[]>;
  };
  /** Worker-side: only enabled, currently assigned connections. Includes no config or credentials. */
  listAssigned(purpose: StoragePurpose, tx?: DbOrTx): Promise<StorageAssignedDestination[]>;
  /** Server-only OAuth support; lock and check the live administrator, kind and version in caller's tx. */
  readProviderSetup(principal: SessionPrincipal, input: {
    publicId: string; kind: StorageProviderKind; expectedVersion: number;
  }, tx: Tx): Promise<{ config: StorageConfig; credentials: StorageCredentials | null }>;
  /** Server-only SharePoint sync support; checks active assignment, provider kind and the worker fence. */
  readAssignedProvider(input: {
    purpose: "order_data"; connectionPublicId: string; kind: "sharepoint"; assertStillOwned: (tx?: Tx) => Promise<void>;
  }): Promise<{ config: StorageConfig; credentials: StorageCredentials }>;
  /** Worker-side: fail closed if disabled/unassigned; verify provider-reported size and digest. */
  copy(input: StorageCopyInput): Promise<StoragePutResult>;
  /** Called inside file publication; stages durable jobs for the active order-file assignments. */
  stageOrderFile(filePublicId: string, tx: Tx): Promise<void>;
  /** Automation-only bulk staging, bounded and constrained to the current order_files assignment. */
  stageOrderFilesForAutomation(input: {
    orderPublicId: string; filePublicId?: string; connectionPublicId?: string; correlationId: string; signal: AbortSignal;
    assertStillOwned: (tx?: Tx) => Promise<void>;
  }): Promise<{ queued: number; cause?: "STORAGE_ASSIGNMENT_INACTIVE" | "STORAGE_COPY_SOURCE_INACTIVE" | "STORAGE_COPY_BATCH_LIMIT" }>;
}
