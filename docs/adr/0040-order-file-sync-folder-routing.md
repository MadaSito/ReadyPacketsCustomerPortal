# 0040 — Order files are copied to assigned storage with configurable folder templates and a per-order sync view (extends 0027)

Status: Accepted (2026-11-21; owner confirmation requested)

## Context
The owner asks that order files sync to SharePoint after an upload or recording, with the destination folder set in the order workflow configuration, and for a SharePoint sync view on each order (increment 04 part B, decision B7).

## Decision
- An order file is copied to every storage connection assigned to "order files" as soon as it becomes available. That means an upload that passed scanning, a saved recording or a converted WebM. SharePoint libraries and OneDrive are among the providers.
- Folder templates:
  - They can be set per upload or recording slot, with a workflow-level default, in the workflow designer ("Storage folder").
  - Precedence: slot, then workflow, then the assignment default.
  - Tokens: `{customer_ref}`, `{order_ref}`, `{order_name}`, `{phase}`, `{slot}`, `{yyyy}`, `{mm}`.
  - Default: `customers/{customer_ref}/orders/{order_ref}/{phase}`.
- Templates are validated on save and again at copy time:
  - relative only, at most 8 segments and 400 characters;
  - no `.` or `..` segment, and no control or provider-reserved characters;
  - token values are reduced to safe segments;
  - the designer shows a live example path.
- The destination path is recorded on each copy attempt and shown in the Copy log.
- Each order has a tab "SharePoint sync (n)", labelled "File sync (n)" when no SharePoint or OneDrive connection is assigned. It shows:
  - totals: total, synced, in progress, failed;
  - a transfer table: file, phase, status, destination, target path, last update and action.
- The tab reads `storage.copies.forOrder` (`orders.read_all`). "Retry" (`storage.copies.retryOrderFile`, `files.manage`, no step-up) appears only for a current failed transfer whose local source file still exists; an uncertain outcome is never resent blindly. "Open Copy log" opens `/admin/storage/copies` filtered to the order.
- Local storage stays the system of record. A failed copy never blocks the customer.

## Consequences
- Renaming an order or changing a reference does not move files that were already copied. Only new copies use the new values.
- Folder creation in the providers is nested and subject to each provider's limits. This has not been verified against a live SharePoint tenant in development.
