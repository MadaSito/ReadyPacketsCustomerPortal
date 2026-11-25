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

## Consequences
- SharePoint mirrors the portal's phase structure. Changes made in SharePoint are not reflected back.
- The `Sites.Selected` permission must be granted to the specific site before the destination test passes.
