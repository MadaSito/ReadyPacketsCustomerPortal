export const COPY_KINDS = ["order_file", "backup_archive", "sharepoint_order"] as const;
export const COPY_STATES = ["queued", "written", "verified", "failed", "not_written"] as const;
export const COPY_VERIFICATIONS = ["checksum", "provider_readback"] as const;

export type CopyKind = (typeof COPY_KINDS)[number];
export type CopyState = (typeof COPY_STATES)[number];
export type CopyVerification = (typeof COPY_VERIFICATIONS)[number];

type AttemptIdentity = {
  kind: CopyKind;
  sourcePublicId: string;
  connectionPublicId: string;
  jobPublicId: string;
  attempt: number;
  correlationId?: string | null;
  bytes?: number | null;
};

export type CopyAttemptEvent = AttemptIdentity & (
  { phase: "queued" } |
  { phase: "started" } |
  { phase: "finished"; alreadyAudited?: true } & (
    { result: "verified"; verification: CopyVerification; errorCode?: never } |
    { result: "written"; verification?: never; errorCode?: never } |
    { result: "failed" | "not_written"; verification?: never; errorCode?: string }
  )
);
