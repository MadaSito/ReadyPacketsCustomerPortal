# E-mail delivery and outbox

Use **E-mail delivery** (`/admin/email-delivery`) to set the From address, display name and optional Reply-To address. Configure and test each transport you plan to use, then select the primary and an optional secondary. If you leave the shared sender blank after an upgrade, the original SMTP sender is used. SMTP and Microsoft Graph must both be permitted to submit using the selected sender before you configure failover between them.

## Audit mailbox and retention

- **Audit copy**: Save the audit mailbox address, request a code, and enter it within 30 minutes. Enabling this option does not send copies until that address has been verified. The copy is a separate message with sensitive template inputs redacted, sent after the provider accepts the customer message. Check its independent result under **Attempts**.
- **Retained content**: Turn on retention only if operators need to inspect rendered mail. The default window is 30 days once enabled; new messages are not saved while this option is off. Expired messages cannot be opened, and the worker clears them in batches. Disabling retention or setting the window to zero hides saved bodies; physical cleanup follows on the next running cleanup job. Backup archives are governed by their own retention.

## Troubleshoot delivery

- **Attempts**: Open **Mail** (`/admin/mail`) to see which transport was used for the primary, secondary and audit copy. Acceptance means the provider took the message, not that it arrived in the inbox. The portal never automatically resends or fails over after an `unknown` result. Check with the provider first. If the encrypted payload has not expired, a verified administrator can acknowledge the duplicate risk and manually queue a new attempt. History keeps the unknown outcome and shows the separate resend.
- **View message**: Where redacted content is still available, this action opens the recipient, subject, plain-text body and HTML source. Opening the dialog requires fresh verification and is audited. The HTML source is shown as text, so it cannot run code, open links or load images.
