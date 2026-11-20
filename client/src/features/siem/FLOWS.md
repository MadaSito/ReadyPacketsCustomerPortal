# SIEM forwarding console flows

- **Overview:** Open Security → SIEM forwarding. Check health and inspect a destination's status, backlog, lag, and last success or failure. `DataTable` uses desktop tables and stacked labeled mobile cards. No provider payloads, TLS secret material, or receiver response bodies appear in this view.
- **Set up a receiver:** Add a destination, select a verified TLS format, enter the receiver, optionally insert CA/client credentials, then review audit categories and minimum severity. Save while paused, send a synthetic test, and explicitly resume forwarding when ready. Confirmation of acceptance at the transport or collector does not establish indexing.
- **Change a receiver:** Edit against the saved version. Rotate or remove credentials bound to a changed endpoint. Existing queued items quarantine by default; migrating them to the new receiver requires explicit selection. New credentials never appear on review or in the saved presentation.
- **Investigate failures:** Open the delivery log for a seven-day record of audited tests and exceptions, or open Quarantine to inspect and act on specific held events. Audit correlation links route to the Audit Center; missing correlation identifiers do not produce links. Replay and purge confirm scope and require step-up. This is not a log of every successful receipt.

The focused jsdom/axe suite covers these screens and interactions with typed client contracts and mocked responses. Browser and live collector checks are reserved for release integration.
