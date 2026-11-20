import type { Readable } from "node:stream";
import type { PortableErrorCode } from "./errors.js";
import type { Manifest } from "./contract/manifest.js";
import type { AnyRecord, RecordOf, RecordType } from "./contract/records.js";

export type SourceFormat = "v3" | "v1" | "v2";

export interface VerificationIssue {
  code: PortableErrorCode;
  message: string;
  recordType?: string;
  line?: number;
  path?: string;
}

export interface VerificationReport {
  ok: boolean;
  packageId: string;
  sourceFormat: SourceFormat;
  contractVersion: string;
  manifestSha256: string;
  ciphertextSha256: string;
  counts: Partial<Record<RecordType, number>>;
  objects: { count: number; bytes: number };
  issues: VerificationIssue[];
  /** Number of issues found (issues[] is capped at 100 entries). */
  issueCount: number;
  warnings: Array<{ code: string; message: string }>;
  /** What a legacy adapter could not carry, or what the producer declared it omitted. */
  losses: Array<{ code: string; message: string; count?: number }>;
  /** Number of fields preserved as held-unknown across all records. */
  heldUnknown: number;
  /** Optional extensions this reader does not understand; retained as inert evidence. */
  heldExtensions: Array<{ name: string; version: string; count: number }>;
}

export interface RecordEnvelope {
  type: RecordType;
  record: AnyRecord;
  line: number;
}

export interface PortablePackage {
  readonly sourceFormat: SourceFormat;
  readonly manifest: Manifest;
  /** SHA-256 of the canonical manifest bytes (v3) or of the decrypted legacy payload (v1/v2). */
  readonly manifestSha256: string;
  /** SHA-256 of the exact input file bytes as opened. */
  readonly ciphertextSha256: string;
  verify(): Promise<VerificationReport>;
  records<T extends RecordType>(type: T): AsyncIterable<RecordOf<T>>;
  allRecords(): AsyncIterable<RecordEnvelope>;
  listObjects(): ReadonlyArray<{ sha256: string; size: number }>;
  openObject(sha256: string): Promise<Readable>;
  /** Raw inert lines of an optional, unknown extension (never interpreted). */
  heldExtension(name: string): AsyncIterable<string>;
  /**
   * v3 only (after a successful verify): archive entry names, and their exact verified bytes. Legacy
   * packages have no verbatim v3 archive and do not implement these.
   */
  verbatimEntries?(): ReadonlyArray<string>;
  openVerbatimEntry?(name: string): Promise<Readable>;
  close(): Promise<void>;
}
