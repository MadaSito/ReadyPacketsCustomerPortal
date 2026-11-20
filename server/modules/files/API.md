# Private files API

## Provider interfaces

- `createObjectStorage({ config: { storageDir }, logger }): ObjectStorage`, as specified in `core/types.ts`. Keys are one of `files|staging|exports|backups|quarantine` followed by `/` and 32 lowercase hexadecimal digits. Only use `newKey(namespace)` to allocate keys. `get` accepts an optional inclusive range. Published objects are immutable; put and move must not intentionally overwrite an existing key.
- `FilesModule.revokeTicketsForOrder(orderId: number, tx?: Tx): Promise<void>` deletes all pending tickets for an internal order ID.
- `FilesModule.reassignOrderFiles(orderId: number, ownerUserId: number, tx: Tx): Promise<void>` updates the owner binding and invalidates tickets in the caller's order reassignment transaction.
- `FilesModule.assertCanReadFile(principal: SessionPrincipal, filePublicId: string, orderPublicId?: string): Promise<FileRecord>` checks current order and file visibility; an optional order binding is enforced.
- `FilesModule.enumerateOrderFiles(principal: SessionPrincipal, orderPublicId: string, options?: { cursor?: string; limit?: number; includeVersions?: boolean }): Promise<{ items: FileRecord[]; nextCursor: string | null }>` is a bounded collector API. It uses live order and visibility policy and returns no deleted files.
- `FilesModule.openForExport(principal: SessionPrincipal, filePublicId: string, orderPublicId: string): Promise<{ file: FileRecord; stream: Readable }>` reauthorizes each file immediately before opening. Raw references or keys are never API inputs.
- `FilesModule.adoptVerifiedObject(input: AdoptVerifiedObjectInput, tx: Tx): Promise<FileRecord>` is the trusted portable import entry point; it binds the caller-provided internal order/owner context created by the import and revalidates staged bytes against target policy before publishing. Caller owns outer rollback compensation for the destination key if the transaction fails. `AdoptVerifiedObjectInput = { principal: SessionPrincipal; publicId?: string; orderId: number; orderPublicId: string; ownerUserId: number; phasePublicId?: string|null; displayName: string; category: FileCategory; visibility: FileVisibility; stagedObject: StoredObjectInfo; destinationKey: string }`.
- `FileRecord` fields: `publicId, logicalPublicId, orderPublicId, phasePublicId, displayName, category, visibility, size, sha256, contentType, extension, version, createdAt, deletedAt`. No tenant-local IDs, object keys, or ticket hashes leave the module's client-facing methods.

## HTTP and tRPC

- `POST /api/files/upload/:orderId` requires a full session and CSRF, accepts streaming multipart `files` fields. Set options via a strict query object (`category`, `visibility`, optional `versionOf`). Response lists individually committed and refused files in multipart order. Malformed or over-limit envelopes are refused before committing files.
- `POST /api/files/download` requires a full session and CSRF; send JSON `{ ticket }`. Tickets are never in URLs. Sends a private attachment; no Range on this endpoint.
- `trpc.files.list`, `.issueDownloadTicket`: full session; current resource authority. Ticket TTL ≤60 seconds and single use.
- `trpc.files.setVisibility`, `.remove`, `.restore`: staff with the respective file capability and current write authority.
- `trpc.files.admin.get`, `.admin.setTypeRules`: admin. Rules can narrow the built-in format allowlist and limits; configuration cannot enable arbitrary formats. Changing rules requires fresh step-up.

## Operations and policy

- Audit events: `file.uploaded`, `file.upload.denied`, `file.download.ticket_issued`, `file.download`, `file.download.result`, `file.visibility.changed`, `file.removed`, `file.restored`, `file.rules.changed`, `file.imported`, `file.retention.purged`. File access records and the durable audit trail contain no display names, raw tickets, or private keys.
- Jobs: `files.retention` (staging, expired tickets and soft-deleted content). Settings key: `files.type_rules`.
- Health: `storage.local`, `files.antivirus` (not configured unless a reviewed scanner has been wired).
