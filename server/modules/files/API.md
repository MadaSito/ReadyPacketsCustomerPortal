# Private files API

## Provider interfaces

- `createObjectStorage({ config: { storageDir }, logger }): ObjectStorage`, as specified in `core/types.ts`. Keys are one of `files|staging|exports|backups|quarantine` followed by `/` and 32 lowercase hexadecimal digits. Only use `newKey(namespace)` to allocate keys. `get` accepts an optional inclusive range. Published objects are immutable; put and move must not intentionally overwrite an existing key.
- `FilesModule.revokeTicketsForOrder(orderId: number, tx?: Tx): Promise<void>` deletes all pending tickets for an internal order ID.
- `FilesModule.reassignOrderFiles(orderId: number, ownerUserId: number, tx: Tx): Promise<void>` updates the owner binding and invalidates tickets in the caller's order reassignment transaction.
- `FilesModule.assertCanReadFile(principal: SessionPrincipal, filePublicId: string, orderPublicId?: string): Promise<FileRecord>` checks current order and file visibility; an optional order binding is enforced.
- `FilesModule.enumerateOrderFiles(principal: SessionPrincipal, orderPublicId: string, options?: { cursor?: string; limit?: number; includeVersions?: boolean }): Promise<{ items: FileRecord[]; nextCursor: string | null }>` is a bounded collector API. It uses live order and visibility policy and returns no deleted files.
- `FilesModule.openForExport(principal: SessionPrincipal, filePublicId: string, orderPublicId: string): Promise<{ file: FileRecord; stream: Readable }>` reauthorizes each file immediately before opening. Raw references or keys are never API inputs.
- `FilesModule.portableFiles(tx: Tx, { principal: SessionPrincipal; after?: string; limit: number; orderIds?: readonly number[] }): Promise<{ items: PortableStoredFile[]; nextCursor: string|null }>` checks portable export capability and verifies actual file owner against current order ownership in the supplied snapshot. Only active current versions are included. `PortableStoredFile = FileRecord & { storageKey: string; ownerPublicId: string; orderId: number; ownerUserId: number }`. Reauthorize before opening bytes.
- `FilesModule.backupFiles(tx: Tx, { after?: string; limit: number }): Promise<{ items: BackupStoredFile[]; nextCursor: string|null }>` is a trusted backup-worker traversal of all byte-bearing rows, including retained soft-deleted files and previous versions. `BackupStoredFile = FileRecord & { storageKey: string }`.
- `FilesModule.validatePortableObject({ stagedObject: StoredObjectInfo; displayName: string; category: FileCategory; contentType?: string }): Promise<{ extension: string; contentType: string }>` validates actual size/hash and classifies independently of sender-declared type.
- `FilesModule.adoptVerifiedObject(input: AdoptVerifiedObjectInput, tx: Tx): Promise<FileRecord>` binds the caller-provided internal order/owner context created by the import and revalidates staged bytes against target policy before publishing. Requires an admin with fresh `portable.import` step-up and `origin=import`. Caller allocates a fresh `files` destination (do not populate), and owns outer rollback or fenced crash compensation for the destination key. Input fields: `principal, publicId?, orderId, orderPublicId, ownerUserId, phasePublicId?, displayName, category, visibility, stagedObject, destinationKey, contentType?`. Phase is represented by current `statusKey` until orders expose separate phase IDs; phase IDs for adoption must currently be absent or null.
- `FileRecord` fields: `publicId, logicalPublicId, orderPublicId, phasePublicId, statusKey, displayName, category, visibility, size, sha256, contentType, extension, version, createdAt, supersededAt, deletedAt`. No tenant-local IDs, object keys, or ticket hashes leave the module's client-facing methods.

## HTTP and tRPC

- `POST /api/files/upload/:orderId` requires a full session and CSRF, accepts streaming multipart `files` fields. Set options via a strict query object (`category`, `visibility`, optional `versionOf`). Response lists individually committed and refused files in multipart order. Malformed or over-limit envelopes are refused before committing files.
- `POST /api/files/download` requires a full session and CSRF; send JSON `{ ticket }`. Tickets are never in URLs. Sends a private attachment; no Range on this endpoint.
- `trpc.files.list`, `.issueDownloadTicket`: full session; current resource authority. Ticket TTL ≤60 seconds and single use.
- `trpc.files.setVisibility`, `.remove`, `.restore`: staff with the respective file capability and current write authority.
- `trpc.files.admin.get`, `.admin.setTypeRules`: admin. Rules can narrow the built-in format allowlist and limits; configuration cannot enable arbitrary formats. Changing rules requires fresh step-up.

## Operations and policy

- Audit events: `file.uploaded`, `file.upload.denied`, `file.download.ticket_issued`, `file.download`, `file.download.result`, `file.export.open`, `file.visibility.changed`, `file.removed`, `file.restored`, `file.rules.changed`, `file.imported`, `file.retention.purged`. File access records and the durable audit trail contain no display names, raw tickets, or private keys.
- Jobs: `files.retention` (staging, expired tickets and soft-deleted content). Settings key: `files.type_rules`.
- Health: `storage.local`, `files.antivirus` (not configured unless a reviewed scanner has been wired).
