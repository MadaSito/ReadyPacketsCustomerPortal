# SharePoint module: verification (increment 03)

All tests ran against **local fakes only**: `FakeGraph` (`storage/adapters/graphDriveFake.ts`), fake storage connections, fake orders and identity, and the local dev MySQL test database. **Nothing was tested against a real Microsoft 365 tenant or the real integrations Graph client.** That client (`server/modules/integrations/graph/**`) did not exist when these tests ran. The binding is typed structurally from integrations API.md §1.2 and tested against a stub only.

| File | Result |
| --- | --- |
| storage/adapters/graphDrive.test.ts | 16 passed |
| storage/adapters/graphDriveGraph.test.ts | 5 passed |
| storage/adapters/graphDriveQuickXor.test.ts | 2 passed. Vectors come from https://github.com/shawze/quickxorhash and https://pkg.go.dev/github.com/excelano/quickxorhash@v1.0.0 |
| sharepoint/folderLabels.test.ts | 6 passed |
| sharepoint/sharepoint.test.ts | 16 passed |

The scoped typecheck (`tc.sh`) and lint are clean for these paths.

What the tests cover:
- Host-lineage refusal before any bytes are sent; no auth on upload calls; session cancel; resume.
- Fence loss, both in the adapter and in the transport.
- Integrity mismatch; idempotent existing objects and conflicts.
- Discovery.
- Ships disabled.
- List compatibility (including the uniqueness requirement); create and update idempotency by order ID; recovery after a lost remote ID.
- Unique-conflict readback; claim serialisation; a stale job is not allowed to regress the version.
- A settings-version change before dispatch; revocation and destination-generation changes; lost fence.
- Step-up denial audit; the staff-only trigger veto.

Not verified:
- Real Graph behaviour, including `enforceUniqueValues` on list columns, `$filter` on indexed columns, upload-session semantics and throttling.
- Container start-up wiring, which is only covered by typechecking.
- The UI.

## Backfill and claim liveness (local fakes only)

These tests run in `sharepoint.test.ts` against a fake orders listing and FakeGraph:

- "dispatches a newer version whose own job exhausted against the busy claim": v2 hits six BUSY refusals while v1 holds the claim. When v1 completes it enqueues a follow-up, the follow-up updates the item, and nothing else is enqueued.
- "backfills existing orders in resumable bounded batches…":
  - Backfill is refused while the sync is disabled and when the administrator has no step-up.
  - It fails closed with `ORDERS_LISTING_UNAVAILABLE` when the listing port is absent, then resumes.
  - It pages by keyset cursor, and the progress count reaches 5.
  - A replayed batch is cancelled, and a restarted run creates no duplicate items.
  - The started, resumed and finished events are audited.

The tests use a fake of the orders module's `listOrderPublicIdsForSync` (commit 039ce05). They don't run against the real implementation.
- "a retryable failure on the final attempt still dispatches a newer staged version".
- "cancels a backfill when its settings or destination scope changes after a page was read": when the destination generation changes, or the sync is disabled, between the listing and staging, nothing is staged. The run fails with `SCOPE_CHANGED`, and it is not resumed silently.
- "does not dispatch already-staged bulk jobs after the destination scope changes": a batch completes under scope A and the destination then changes before the jobs drain. The order job is cancelled, nothing is written, and a later ordinary order change syncs normally.
