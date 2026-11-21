# 0027 — Cloud storage connections are copy destinations; local storage stays the system of record

Status: Accepted (2026-11-21). Supersedes the SharePoint part of ADR 0020.

## Context
The owner asked for connections to Amazon S3, Wasabi, Backblaze, Azure Blob, Dropbox, Google Drive,
Microsoft OneDrive and SharePoint, and for order data to be synchronised to SharePoint.

## Decision
- Private files continue to be stored, scanned, authorised and served from the server's own storage.
  A storage connection is a destination for copies: order files, verified encrypted backups, order data.
- One adapter interface; adapters for S3-compatible services (signature version 4; presets for Amazon S3,
  Wasabi and Backblaze B2), Azure Blob, Microsoft Graph drives (SharePoint libraries, OneDrive for
  Business), Dropbox and Google Drive. Requests are signed by our own code and sent through the egress
  policy; vendor SDKs are not used.
- Credentials are encrypted, write-only and changed only after step-up. Copies run as fenced background
  jobs with per-file state and retries. The portal never deletes remote objects on its own.
- SharePoint order sync writes one list item per order and is idempotent by the order's public id.

## Consequences
Removing a file in the portal does not remove its cloud copy; retention there is the administrator's
responsibility and is stated in the privacy notice draft. Serving downloads directly from cloud storage
is a possible later step and would need its own decision.
