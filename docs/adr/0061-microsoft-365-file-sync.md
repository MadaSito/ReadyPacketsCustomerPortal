# 0061 — Microsoft 365 / SharePoint one-way file sync per phase

Status: Proposed (drafted from INCREMENT_07_CONTRACT.md; to be corrected against the owners' API.md as packages land)

## Context
The owner asked for Microsoft 365 / SharePoint sync "so order files can be properly synced". Their earlier editor routed files per phase to originals, conversion-staging and intake-delivery targets under `CustomerName-CustomerID/OrderNumber`. Storage connections and folder routing exist ([ADR 0027](0027-storage-connections.md), [ADR 0040](0040-order-file-sync-folder-routing.md)).

## Decision
- **One-way.** The portal stays authoritative; nothing done in SharePoint changes the portal.
- **Per phase in the editor:**
  - a document folder and an audio folder (defaults `{phase_key}/Docs` and `{phase_key}/Audio`);
  - three targets: originals, conversion staging and intake delivery. Each is an approved destination or "Do not transfer".
- **Layout.** The managed layout is `CustomerName-CustomerID/OrderNumber/<phase folder>`. The root segments are frozen at first export.
- **Tokens.** New tokens `{phase_key}`, `{order_number}` and `{customer_folder}`. Old workflows keep their tokens.
- **Sources:**
  - scanned originals, from customers and staff;
  - recordings, and the WebM derivative **and** its original;
  - saved Word edits, as new versions;
  - receipt PDFs, to a restricted "Receipts" target. This source is off by default.
- **Operations:**
  - **Destination test.** It proves the portal can write, not only read.
  - **Resync.** One file, one order, or a bounded run with a dry-run count first.
  - **Health.** Last success, backlog and blocked items, with alerts ([ADR 0058](0058-outbound-webhooks-and-operational-alerts.md)).
  - **File sync tab.** It shows the role, the destination and the state.
- **Failure handling:**
  - uploads never fail because Graph is offline;
  - unknown outcomes are reconciled, never blindly replayed.
- **Not built.** Two-way sync, remote delete or move, placeholder files and shared links. Server-side document conversion profiles (PDF compression, PDF ↔ Word ↔ text) need LibreOffice or Ghostscript and are proposed for a later increment; audio to WebM stays.

## Assumptions to confirm with the owner
- File sync targets and receipts to Microsoft 365 are off until configured.
- "Conversion staging" receives the original audio and the WebM derivative; no document conversion runs.

## As implemented

Package L, as reported by the owner:

- **Connection.** File sync uses a dedicated private SharePoint connection with the Graph and Graph upload egress presets.
- **Write check.** After the ordinary read test, the write check is session-based and creates no file.
- **Approval.** A destination is approved explicitly, either for phase files or as the only, restricted Receipts target. The phase selectors default to off.
- **Resync.** It is bounded to 100 existing failed or blocked intents, with a dry run first.
- **Uncertain uploads.** They are inspected, not replayed.
- **No backfill.** Files from before sync was switched on are not copied.
- **Intake delivery scope (lead decision).** Intake delivery gets only customer-visible, admitted phase files (admitted = passed the portal's byte and type checks and the configured scanner if present; production does not configure external antivirus by default) and verified audio derivatives, on publication. Staff-only files and pending or unconverted originals go only to Originals. There is no phase-submit hook.
- **OneDrive.** It needs tenant-wide application file permissions, so SharePoint with `Sites.Selected` is preferred.

## Consequences
- SharePoint mirrors the portal's phase structure. Changes made in SharePoint are not reflected back.
- The `Sites.Selected` permission must be granted to the specific site before the destination test passes.
