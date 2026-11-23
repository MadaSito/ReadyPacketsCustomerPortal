# 0053 — Policy import, update notices, enforcement and the order agreement (MNDA)

Status: Accepted (2026-11-23; implemented in increment 06 and checked in the lead's QA browser run — see STATUS.md. Assumptions below remain open for owner confirmation)

## Context
The owner asked for six things:
- policies can be imported from Word, Markdown or PDF;
- policy updates prompt users, with a countdown to the notice and a button to notify everyone;
- users who do not accept can be disconnected after a customisable warning;
- an MNDA must be accepted before ordering or working on an order;
- a typed-name signature must match the signed-in person.

Acceptance evidence and the gateway already exist ([ADR 0039](0039-policy-acceptance-gateway.md), [ADR 0045](0045-policy-acceptance-log-centre.md)). Ending sessions and blocking work can lock people out, so these features are off until the owner configures them.

## Decision
- **Typed name check** (`compliance.signature_name_check`, `mode` `require` / `warn` / `off`, default `require`).
  - **Comparison.** Both names are compared after Unicode NFKC normalisation, ignoring case, diacritics and punctuation, with whitespace collapsed. The typed name passes when it equals the account's full name, or its first and last name with middle names left out.
  - **Who decides.** The server decides. The client shows the expected account name and a link to correct the profile name; a name change is audited.
  - **Scope.** The check applies to policy acceptance and to workflow gates with `typed_name`, through one compliance port.
  - **Record.** The result is stored with the acceptance and shown in the acceptance log centre. Mismatches are audited without storing the typed text in clear.
- **Import.** The New policy and New version dialogs gain **Import from file** (`DocumentImportButton`, [ADR 0052](0052-word-editing-in-portal.md)).
  - Word and Markdown keep headings, lists, emphasis, links and tables. PDF import extracts text only, and the dialog says so.
  - Imported text lands in the editor for review. An import never publishes, and the server sanitises imported text as it does typed content.
- **Update notice.** Publishing a version of a policy that requires acceptance creates a notice, scheduled at publish time + `noticeDelayHours`. The delay is set per policy, defaults to 24 and can be 0; the administrator can also pick a date and time.
  - **Controls.** The policy page shows a live countdown, plus **Send notice to everyone now** (`policies.notices.send`, step-up, confirmation with the audience count), **Change time** and **Cancel notice**.
  - **Sending.** E-mail (template `policy_update_notice`) is queued in batches to every user in the audience who has not accepted, and an in-portal notification is created. Sending is idempotent per version and user.
  - **Reminders.** **Remind those who have not accepted** re-sends only to them, rate limited per version.
  - **Progress and audit.** The page shows queued, sent, failed and accepted counts, and each step is audited as `policy.notice.*`.
  - **Sign-in prompt.** Users with a pending required policy are prompted at sign-in and on the next navigation, with the change summary when one was written.
- **Enforcement.** Each policy has `enforcement { mode, graceHours, warningText, appliesTo }`.
  - **Settings.** `mode` is `none` (the default) or `required_to_continue`. `graceHours` is 0–720. `warningText` is plain text of at most 1,000 characters, with the placeholders `{policy}`, `{deadline}` and `{timeLeft}`. A site-wide default warning is editable.
  - **Grace period.** During the grace period the user sees the warning with a countdown and **Accept**, **Read** or **Later**.
  - **Ending sessions.** On "I do not accept", or when the grace period ends, every session of the user is ended (`endSessionsForUser`), and the audit records `policy.enforcement.session_ended`.
  - **Next sign-in.** The next sign-in lands in the existing remediation state with a new step, `accept_policy`. In that step the user can read and accept, or sign out, and nothing else. Accepting makes the session full. The server enforces this.
  - **Admin action.** Administrators can **End sessions now** for a user who has not accepted (`sessions.revoke_any`, step-up).
- **Enforcement lock-out safety:**
  - enforcement never applies to an unpublished policy;
  - switching it on shows how many users are affected and needs confirmation;
  - administrators are prompted like everyone else but can always reach the acceptance step;
  - a break-glass note in `docs/operations` explains how to switch enforcement off from the server.
- **Order agreement (MNDA).** The setting `orders.agreement_gate` defaults to:

  ```
  {
    enabled: false,
    policyPublicId: null,
    applyTo: { placeOrder: true, workOnOrder: true },
    signatureMode: "typed_name" | "checkbox",
    askAgainOnNewVersion: true
  }
  ```

  - **Admin card.** The card "Order agreement (MNDA)" is on the Policies page and in the workflow settings. It cannot be switched on without a published policy.
  - **Mechanism.** It is an implicit gate on the ADR 0039 gateway, so there is one mechanism.
  - **What it gates.** For customers it gates cart checkout and order creation (`placeOrder`). It also gates uploads, recordings, document edits, task acknowledgements and customer transitions (`workOnOrder`).
  - **Blocked actions.** A blocked action returns `AGREEMENT_REQUIRED` with the policy public id. The client opens the acceptance dialog and then repeats the action.
  - **Not gated.** Staff may create an order for a customer, but the customer must accept before working on it. API v1 keys are not customers and are not gated.
  - **No legal text.** No legal text is shipped; the owner imports their own MNDA.

## Assumptions to confirm with the owner
- The name check is on (`require`) after upgrade.
- Enforcement and the MNDA gate are off until configured.
- Ending sessions is the agreed meaning of "disconnected".
- The notice delay defaults to 24 hours.

## Consequences
- The portal records and enforces acceptance. It does not decide whether a policy or an MNDA is legally sufficient; that is the owner's responsibility.
- A name check can refuse people whose profile name is wrong; the link to correct it is the remedy.
