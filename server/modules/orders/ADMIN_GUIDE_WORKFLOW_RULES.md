# Workflow phases, requirements and console order actions

Administrator guide chapter (increment 04, orders module). Owner: orders_engineer. Both features ship switched off.

## Before you start

Two settings under **Settings**. Each change is audited.

| Setting | Default | What it allows |
| --- | --- | --- |
| Workflow phases and requirements (`orders.workflow_rules.enabled`) | Off | Publishing workflows that have phases, required uploads or acknowledgements. Rules that are already published keep being enforced when you turn it off again. |
| Console access grants (`orders.console_access.enabled`) | Off | Giving another platform user access to one order, or to all of a customer's orders. |

Creating an order for a customer and reassigning an order only need the matching capabilities (see below). They do not need a setting.

## Phases

A phase groups statuses that belong together, for example Intake, Review and Delivery. Customers see the phases as a progress rail at the top of their order.

- Add phases in the workflow designer, either in the **Phases and requirements** wizard step or in the **Phases** card next to the canvas. A workflow can have up to 12 phases. Each phase has a name and a key made of lowercase letters, digits and underscores.
- Give each status a phase. The designer warns you when a status has no phase, or when a phase has no statuses.
- **Locking:** when an order moves to a status in a different phase, the phase it leaves is locked. Uploads, acceptances and customer edits in a locked phase are read-only, so what you reviewed stays the way you reviewed it. If a permitted transition brings the order back into an earlier phase, that phase is reopened. Both events are audited (`order.phase.locked`, `order.phase.reopened`).
- **Unlocking:** staff with the `orders.phase.unlock` capability can use **Unlock a phase** on the order page. You must give a reason of 10–500 characters. It is stored as an encrypted internal note that customers never see. You can also choose whether to notify the customer. The phase locks again at the next status change. Audit event: `order.phase.unlocked`.
- An order-level lock (review, finalized, legal hold, imported read-only) always takes priority over phase state.

## Requirements per status

Requirements are the things that must be done before an order can **leave** a status. Moving the order to a cancel status is exempt. If something is still missing, the move is refused and the order page lists what is needed under **Needed before the next step**.

### Uploads (up to 10 per status)

| Field | Meaning |
| --- | --- |
| Upload name, key | Shown to the customer (for example "Signed contract"); the key links files to this slot. |
| Kind | Document or audio. |
| At least / at most | 0–20 and 1–20. "At least 0" makes the slot optional. |
| Accepted file types | Extensions such as `pdf, docx`. Leave empty to allow any type the Files module accepts for that kind. |
| Who may upload | Customer, Staff, Administrator, API integration (at least one). |
| Hint | Optional plain text, up to 200 characters. |

### Acknowledgements (up to 5 per status)

| Field | Meaning |
| --- | --- |
| Title and full text | Plain text only (no HTML or Markdown links). The text can be up to 8,000 characters and is shown in full, in a scrollable area, before the person accepts. |
| Accepted by | The customer (the owner or a contributor) or our staff. |
| Require typing a full name | The typed name is stored encrypted with the acceptance. |

Each acceptance is recorded once and is never edited or withdrawn. The record holds a SHA-256 fingerprint of the exact text that was shown, the workflow version, the status, the user, their role, the session and the time. If you publish a new version with different text, orders already in progress keep their pinned version. New orders need the new text accepted. If the text changed while someone had it open, the server refuses the acceptance (`ACK_TEXT_CHANGED`) and the person has to read it again.

Final statuses should not have requirements, and the designer warns you if they do.

## Transitions by integrations

Tick **API integration** in "Who may move" to let `/api/v1` callers move orders along that transition. API keys never act as a user. Requirements and phase locks still apply to these moves.

## Console order actions

All three actions are on the console order page in the **Administration** card. You can also start them from the console **Orders** list or from the **Orders** tab of a customer record.

| Action | Who | Notes |
| --- | --- | --- |
| New order for a customer | Staff with `orders.manage` | Search for the customer by name, email or customer reference (emails are shown masked). Pick items and quantities, then create. The customer owns the order. Prices come from the current catalog. |
| Reassign to another customer | Administrators | Pick the new owner with the same customer search, choose a reason and type the order reference to confirm. Verification (step-up) is required. Every share is revoked and file ownership moves with the order. |
| Access for other users | Viewing the list: staff with `orders.read_all`. Granting and revoking: administrators with `orders.access.grant` and step-up | Grant **Viewer** or **Contributor** access to one order or, from the customer record, to all of that customer's current and future orders. The grantee must be an existing active account other than the owner. The answer is the same for unknown and ineligible addresses. Both people are notified. Audit events: `order.access.granted` and `order.access.revoked`. Revoking a customer-wide grant also revokes the order grants created from it. |

## Troubleshooting

| Message | Meaning |
| --- | --- |
| "Some items are still needed before this order can move on." | Look at the order page checklist. Upload the missing files or get the required acceptances. |
| WORKFLOW_RULES_DISABLED when publishing | Turn on **Workflow phases and requirements**, or remove the phases and requirements from the draft. |
| PHASE_LOCKED | The phase is locked. Unlock it with a reason if a change is really needed. |
| FEATURE_DISABLED on Grant access | Turn on **Console access grants**. |
| TOO_MANY_ORDERS | A customer-wide grant covers at most 500 orders. Grant access per order instead. |
