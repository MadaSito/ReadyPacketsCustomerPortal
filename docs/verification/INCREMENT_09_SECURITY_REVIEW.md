# Increment 09 security review

Record for contract D4. Scope: D1 (links in e-mail), D2 (trash, restore, permanent deletion, retention) and D3 (logo and brand files) on `feat/increment-09`.

**Method.** A source review by http_security_engineer, in several rounds, with findings sent to the owning engineers and to `/root`. It was not a penetration test. **Outcome (reported by /root):** D1, D2 and D3 CLEAR at the end of the review.

This record lists the binding design decisions and the findings known to the documentation owner. The reviewer's detailed finding texts went to the owners and are not reproduced here.

## Design review, accepted before implementation

| Item | Where | Decision |
| --- | --- | --- |
| D2.8 security addendum | e825484, 9b40ce8 | The server decides scope. Bulk actions carry an explicit list of at most 100 items. Typed intent is checked on the server. Idempotency keys are bound to actor, action and entity. Each cascade has one claim. Purge is durable and fails closed. The e-mail address stays reserved until the tombstone. Retention changes use compare-and-set with a reviewed count. In-flight work is fenced. Legal hold, storage cases A–D and the rule against truncated target sets were added. |
| D1/D3 security addendum | c079e42 | Link provenance: only template text and trusted link variables become anchors. `mailto` links are safe. Brand files are same-origin and versioned. |

## Findings fixed during the review

| Finding | Fix | Evidence |
| --- | --- | --- |
| The generic settings write could change the three trash retention settings, bypassing the Trash centre preview, typed confirmation, step-up and compare-and-set. | 980f4ec: `ownerWriteOnly` flag in the settings registry. The generic write, `setSecret` and configuration import refuse with `SETTING_OWNER_MANAGED`, and export leaves these settings out. a764b69: the flag is set on the three keys. | platform_engineer's runs: `settingFields.test.ts` 8/8, `router.example.test.ts` 7/7, `configTransfer.example.test.ts` 9/9. |
| A purge participant could keep writing after its worker had been replaced. | 700ff9c: `TrashPurgeRun.assertCurrentInTx` is required. Every participant calls it first in each data-changing transaction and before provider calls (561f6da, 66c234a, 5aa212a, 5c94588, b98465a, 2c4b764, 8014938, 2ab4008, 82ae0e0, 947a37c, a3c0d05). | One test per participant: a lost fence leaves data unchanged (owners' reports). |
| Coordinator ordering and ownership: takeover lock order, sweep fence, idempotency claim ownership. | 851cf45, 9d9a0ba, fc4562b, 8e5da4e | recovery_ops_engineer's tests (owner's report). |
| Mail link provenance and older queued mail without a trash binding. | cd822d3, 3f07684, 2c4b764 | `deliveryLinks.test.ts`, in the lead's full run. |
| Acknowledgement of unreachable storage copies tied to the failed run. | 21b4149, c766b5b | files_engineer's tests (owner's report). |
| Identity follow-ups: owner check fails closed under locking, reset jobs bound to the intake ID, and the sign-in log hides accounts that are gone. | e3b9e92 | identity_engineer's tests (owner's report). |
| Cart: lock order on restoring a checkout, liveness fails closed, add-on targets fenced. | 15b0164, 38165e0 | recovery_ops_engineer's tests (owner's report). |
| Checkouts of trashed or tombstoned orders. | ada5608: normalized to `INVOICE_NOT_FOUND`. | integrations_engineer's tests (owner's report). |

## Limits

- This was a source review only. There was no live penetration test, and no real mail client, storage provider or payment provider was used.
- The accepted risks and known gaps are listed in [STATUS.md](../application-context/STATUS.md#accepted-risks-and-known-gaps-increment-09).
