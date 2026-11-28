# Trash Module (`server/modules/trash`)

Owner: `recovery_ops_engineer` (Increment 09, Decision D2 & D2.8).

## Responsibilities
- Participant registry (`TrashRegistry` / `TrashParticipant` in `./ports.ts`).
- Coordinator (`./service.ts`) orchestrating move-to-trash, restore, resumable fenced permanent deletion (`trash_purge_runs`), unreachable external storage-copy acknowledgment (`finishLeavingExternalCopies`), retention settings (`trash_retention_state` + `platform_settings` with `ownerWriteOnly: true`), and hourly retention clean-up (`trash.retention_cleanup`).
- tRPC router (`export const trashRouter` in `./router.ts`), mounted as `trash: trashRouter` in `server/trpc/root.ts`.

## Security & Concurrency Invariants (D2.8)
1. **Canonical lock order**: `users -> sessions -> orders -> trash_purge_runs` (`actorGuard` + customer/order cascades).
2. **Fail-closed ports & participants**: Missing `identity.trash`, `orders.trash`, or any participant in `EXPECTED_CONTAINER_PARTICIPANTS` refuses purge with `503 UNAVAILABLE` (`TRASH_OWNER_PORT_MISSING` / `TRASH_PARTICIPANT_MISSING`) before tombstoning.
3. **Durable per-target run lease & fencing**: `trash_purge_runs` persists `leaseOwner`, `leaseExpiresAtMs`, and monotonic `fencingToken` (`attempt_count`-CAS). Checkpoints and Phase-3 tombstones re-verify `{ status: "running", leaseOwner, fencingToken }` under `FOR UPDATE` and prevent overlapping order vs owning-customer purges.
4. **Legal hold & bounded cascades**: Orders with `lock_state = 'legal_hold'` and customers owning any legal-hold order fail move-to-trash and permanent deletion with `409 ORDER_ON_LEGAL_HOLD` (`"Release the legal hold first."`). Retention sweeps skip legal-hold items and emit an `opsAlerts` alert (`ORDER_ON_LEGAL_HOLD`). Cascades exceeding `10,000` rows fail closed without truncating.
5. **Single-order unreachable external-copy gate**: `finishLeavingExternalCopies` requires `trash.purge` + fresh step-up + server-checked typed order number on a single-order failed run (`EXTERNAL_COPIES_UNREACHABLE`), records `order.purge_external_left` before destructive retry, and is never forwarded across cascades or retention sweeps.
6. **Pre-effect DB idempotency**: `trash_idempotency_keys` reserves keys before any mutation, binds `(actorUserId, capability, operation, keyHash, fingerprintHash)` plus per-target `batchId` generations, and rejects cross-generation replay.
7. **Retention CAS & `ownerWriteOnly`**: `trash.auto_purge_enabled`, `trash.retention.order_days`, and `trash.retention.customer_days` set `ownerWriteOnly: true` and `exportable: false`, blocking generic `platform.settings.set`. Updates serialize under `trash_retention_state` `FOR UPDATE` against `FOR SHARE` cohort mutations and require exact `expectedVersion`, `reviewedDueCount`, and `DELETE <N>` confirmation when shortening or turning automatic clean-up on.
