# Portable transfer verification

This is a business-record transfer, not a full installation backup or a legacy migration acceptance report. The portal export surface currently covers customer profiles, orders, order lines, order-status history and current active order files. The manifest records collector exclusions.

## Reproduce

```sh
source scripts/dev/env.sh
scripts/dev/test.sh server/modules/portable client/src/features/portable
scripts/dev/tc.sh 'server/modules/portable|client/src/features/portable'
scripts/dev/lint.sh server/modules/portable client/src/features/portable
```

- **Two isolated MySQL schemas**: The server suite uses distinct source and target installations, field-crypto keys, and real Identity, Orders, Files, and Portable services. It checks package verification outside the portal workflow, absence of the fixture credential marker, all three selection modes, export expiry and audit-gated removal, dry-run conflicts, stale session and audit refusal, tamper refusal, object move recovery, replay without duplication, pending identities, read-only orders, target bytes and source timestamps, and separate approval and acceptance actors.
- **Controlled faults**: The service suite uses fake session resolution, an in-memory object store, a simulated fence, fake audit and the test job registry. Its interrupted move case writes the private destination object before failing the simulated worker, then verifies that the next run uses receipts and exact bytes instead of making a duplicate. This does not validate actual queue lease loss, production audit durability, physical storage permissions, or proxy/TLS settings.
- **Admin UI**: jsdom/axe checks representative histories, upload availability, both wizard screens, focus transition, and held-content/reconciliation states. It excludes computed contrast and is not a browser, mobile, screen-reader or ADA compliance certification.

## Release limits and proposed decisions

- **Historical modules**: This portal export does not collect engagement, support, billing, or compliance evidence; permissions/grants, internal notes and historical file revisions are excluded. When verified input contains historical evidence, inactive file versions, or optional unknown extensions, retain them inert rather than inserting live module rows or replaying side effects. Decide which historical evidence must be portable and which parts may be shown to authorized target users.
- **Custody and retention**: Local encrypted escrow survives request completion. The independent reader and file classifier use private plaintext spools/staging; an interrupted process can leave staging bytes. Provision encrypted, access-restricted volumes with space limits. Adopt an audited import retention and reviewed garbage-collection policy for quarantined input, escrow, prepared objects and orphaned workspaces before unattended operation.
- **Conflicts**: No auto-link on email and no overwrite. Existing immutable mappings may link the same reserved package and record digest. Source order references may be remapped by Orders with provenance retained. Explicit skips, external-target matches, and a UI to resolve conflicts are not implemented. Do not treat same-package retries as permission to modify previously imported rows.
- **Recovery**: The worker safe-retry contract is bounded by Jobs attempt limits and current approver authority. If attempts are exhausted or authorization/audit is unavailable, inspect the Job Console and oldest durable import checkpoint; the transfer can remain at its last checkpoint. No automatic rollback of committed rows, reservation clearance or unattended resume across expired approval. Decide how operators reauthorize or resolve held work without bypassing immutable receipts.
- **Availability and scope**: Encryption and verification hold the initiating request open; proxy limits and scratch budgets require environment testing. Packaging compares files to the snapshot and live checks, not an object-store snapshot. No scheduled, remote-delivered, multi-part, or production-tested bulk transfer. A passphrase protects custody but does not independently prove who originally produced a package.
- **Final acceptance**: Two distinct administrators are required across apply approval and acceptance. The accepting administrator attests separate access, lock and authorized-download checks; the automated service only verifies defined data and custody receipts. Neither legacy source compatibility nor production target acceptance was exercised by this suite.
