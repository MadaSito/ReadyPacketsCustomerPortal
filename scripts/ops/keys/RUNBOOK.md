# Key management runbook

Owner: platform engineer. Tools live in this folder. They never log key material, and their error messages name variables and rules only.

| Tool | Purpose | Exit codes |
|---|---|---|
| `pnpm tsx scripts/ops/keys/generate.ts --out-dir DIR` | Creates a fresh installation key set as 0600 files in a 0700 directory. It refuses to overwrite and prints only the `NAME_FILE=path` lines. | 0 ok, 64 usage, 1 failure |
| `… generate.ts --stdout` | Prints `NAME=value` once, for piping straight into a secret manager. Do not run it in a logged terminal or CI. | same |
| `RP_DATA_KEYRING_FILE=… generate.ts --rotate-data-key --out-dir DIR [--key-id ID]` | Writes a new keyring with a new current key, keeping the old keys. | same |
| `RP_DATA_KEYRING_FILE=… generate.ts --retire-data-key ID --out-dir DIR` | Writes a keyring without `ID`. It refuses to remove the current key. | same |
| `pnpm tsx scripts/ops/keys/doctor.ts [--json]` | Validates the whole environment without starting the server. Output contains names and rules only. | 0 ok, 78 config errors |

## Key inventory

| Variable | Purpose | Rotatable online |
|---|---|---|
| `RP_DATA_KEYRING` | AES-256-GCM field encryption. Envelope: `rpenc:v1:<keyId>:<iv>:<ct>:<tag>` | Yes: dual-read keyring, up to 16 keys |
| `RP_INDEX_KEY` (+ `RP_INDEX_KEY_PREVIOUS`) | Blind-index HMAC used for equality lookups, such as email | Yes: dual lookup during the transition |
| `RP_PSEUDONYM_KEY` | Audit/SIEM pseudonyms | Rotating it breaks correlation across the rotation point. Record the date in the audit log center. |
| `RP_TOKEN_HASH_KEY` | Hashes of single-use tokens (reset, invite, verification) | Rotation invalidates outstanding tokens. Users simply request new ones. |
| `RP_AUDIT_CHAIN_KEY` | Tamper-evidence chain for audit events | Only at a documented chain checkpoint. Keep the old key offline to verify historic segments. |
| `RP_BACKUP_KEY(_FILE)`, `RP_BACKUP_KEY_ID` | Backup archive encryption, owned by recovery_ops (see docs/runbooks/key-rotation.md) | Yes: keyring by id. Old ids must stay available for as long as archives under them are retained. |

Each key is single-purpose and the values must be distinct. Prefer the `_FILE` variants (mode 0600, owned by the service user). The loader rejects group- or world-readable files and symlinks.

## Data-key rotation (RP_DATA_KEYRING)

1. Generate: `RP_DATA_KEYRING_FILE=/etc/readypackets/secrets/rp_data_keyring generate.ts --rotate-data-key --out-dir /etc/readypackets/secrets.new`.
2. Deploy the new keyring file to every node and restart them one by one. New writes use the new current key. Old envelopes stay readable because the key id is in the envelope and is bound into the AAD (`rpenc:v1:<keyId>:<aad>`), so swapping key ids is detected.
3. Re-encrypt in the background. The platform re-encryptor (`createReencryptor`, `server/modules/platform/reencrypt.ts`) processes one bounded batch per transaction. It holds the checkpoint row FOR UPDATE, writes with compare-and-swap on the old envelope, advances a monotonic checkpoint and writes an audit event in the same transaction. It resumes after a crash. A reset is audited as `platform.crypto.reencrypt.reset`.
4. Verify that the `platform.keys` health component and the keyring status show zero envelopes under the old id for every target in the AAD inventory below.
5. Retirement criteria, all of which must hold:
   - Zero envelopes reference the old id in every encrypted column.
   - No backups still within retention were taken while the key was the only key for some rows, or the old key is escrowed offline with the backup key notes.
   - No portable/config export documents still needed carry data under it.
   Then run `--retire-data-key <old>` and redeploy.
6. If anything fails, roll back by redeploying the previous keyring file. This is always safe before retirement.

## Blind-index transition (RP_INDEX_KEY)

1. Generate a new 32-byte key (`generate.ts --stdout`, then take `RP_INDEX_KEY` only).
2. Set `RP_INDEX_KEY_PREVIOUS` to the old value and `RP_INDEX_KEY` to the new one. Lookups try both candidates (`blindIndexCandidates`) and new writes use the new key.
3. Recompute the stored indexes, for example by the identity module recomputing `users.email` indexes from the decrypted value.
4. When no row still matches only the previous key, remove `RP_INDEX_KEY_PREVIOUS`.

## AAD inventory (context binding per encrypted column)

The AAD binds each ciphertext to its column and row, so copying a ciphertext into another row or column fails to decrypt. Owners of new columns must add them here.

| AAD prefix | Owner |
|---|---|
| `platform_settings.secret:<key>` | platform |
| `users.email:<id>`, `users.name:<id>`, `user_sessions.csrf:<id>`, `assurance_passkeys.name_enc:<id>`, `identity.token:<id>` | identity |
| `job_runs.payload_enc:<ULID>`, `mail_outbox.payload_enc:<ULID>`, `mail_outbox.capture_enc:<ULID>` | jobs |
| `audit_events.source_address:<id>`, `audit_cases.title`, `audit_case_notes.body`, `audit_legal_holds.label` | audit |
| `backup_legal_holds.note` | recovery_ops |
| `order_files.display_name`, `order_grants.invitee_email`, `order_notes.body` | orders/files |
| `intake_submissions.answers`, `intake_submission_revisions.answers`, `intake_submission_revisions.note` | intake |
| `engagement_order_messages.body`, `engagement_support_tickets.subject`, `engagement_support_ticket_messages.body` | engagement |
| `compliance_invoice_payments.notes`, `compliance_invoice_refunds.notes`, `policy_acceptances.signer_name` | compliance |
| `portable.record:<…>` | portable |

The prefixes were gathered from the source with `rg '\`[a-z_]+\.[a-z_]+:\$\{' server`. Re-run that command before each rotation and compare the result against this table.

## Backup key notes

Backups are encrypted with `RP_BACKUP_KEY` and not with the data keyring. The rows inside a backup are still field-encrypted under whatever data key was current at the time. A restore therefore needs both the backup key id that the archive names AND every data key id referenced by the restored rows. Escrow retired data keys offline, alongside the backup keys, for the full backup retention period.
