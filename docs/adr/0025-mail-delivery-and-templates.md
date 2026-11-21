# 0025 — Mail delivery: two transports, audit copy, stored content, template centre

Status: Accepted (2026-11-21)

## Context
Administrators could resend mail and see attempts, but not read what was sent, set the sender, keep an
audit copy, use Microsoft Graph, or edit the wording.

## Decision
- Transports sit behind one interface: SMTP and Microsoft Graph (`sendMail`, application permission).
  The administrator chooses a primary and an optional secondary. The secondary is used only when the
  primary definitely did not accept the message. An unknown outcome is never replayed and never fails
  over (as before this change); it is shown for operator review, so delivery can never produce a duplicate.
- One sender identity (from address, name, reply-to) applies to every transport.
- An audit copy address can be set for all outgoing mail. Messages that carry single-use secrets (reset,
  activation, invitation, verification links) are copied with those values redacted.
- The rendered message is stored encrypted for a bounded retention period with the same redaction. Reading
  it requires an administrator, step-up and leaves an audit event.
- Templates are data: versioned, draft and published, HTML or plain text, logic-less `{{variable}}`
  substitution with escaping, HTML sanitised against an allow-list on save and on render. Built-in
  templates can be customised and reset; variables a security message needs cannot be removed.
- Template HTML is never inserted into the console document; previews are shown in an inert frame.

## Consequences
An audit mailbox cannot be used to take over accounts. Rich HTML is limited to the allow-list (no scripts,
forms, remote styles or tracking pixels beyond https images).
