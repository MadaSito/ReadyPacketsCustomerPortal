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

## The default workflow for new orders (increment 07.2)

The top of **Workflows** shows **Default workflow for new orders: name (version N)**. To change it, choose **Set as default** on another published workflow and confirm (you are asked for your password and authentication code). After that:

- Orders created from then on use that workflow's latest published version. If you publish a newer version later, new orders use the newer one. This covers orders customers place, cart checkout, orders staff create for a customer, and orders created through the API.
- Existing orders keep the workflow version they started with.
- Workflows are not chosen per product or package, so there is nothing else to change.

A draft cannot be the default until it is published. When you publish a draft for a new workflow, you can tick **Use for new orders (default workflow)**; otherwise publish it and use **Set as default** later. Every change is recorded in the audit log (`workflow.default.changed`, with the previous and the new default).

## Phases-first workflows (increment 07)

New installations start with the **ReadyPackets standard workflow**: Payment, Phase 1 intake, Phase 2 synthesis, Phase 3 review, Phase 4 delivery, Delivered and Closed. On an existing installation nothing changes by itself. While the default workflow has no phases, **Workflows** shows a notice with two choices: **Add the ReadyPackets phases workflow** (a new draft) or **Convert … to phases** (a draft of the default in which its statuses are grouped into phases; an open draft without phases is converted only after you confirm). Check each phase and publish when you are ready. Orders that already exist keep the version they started with.

- **Phases view.** In the designer, a draft with phases opens on **Phases**. Each phase lists its statuses (each status belongs to at most one phase), the customer actions it allows (documents, questions, recording, audio upload, team file review), its acknowledgement, and how it ends. **Next** finishes the phase. **Submit and lock** records the customer's submission and locks it. For a draft without phases, choose **Start phases from statuses**.
- **Targets.** Webhook targets and file sync targets are checked when you save and when you publish. If a target no longer exists, the save is refused and the phase field shows why.
- **Customer progress.** Customers see a progress bar and their current phase on the order and in their order list. Progress only goes forward. The one exception is when an administrator reopens a phase.
- **Review.** When a customer submits a phase, the order shows **Needs staff review**. Staff with the review permission accept the submission or ask for changes. Asking for changes requires a note for the customer.
- **Reopen.** Only an administrator can reopen a locked or accepted phase, after confirming their identity again. A reason of 10–500 characters is required. The reason is kept as an internal note and audited. **Unlock a phase** is not used for workflows with phases.
- **Payment.** An order with an amount due starts as **Unpaid**. When its invoice is paid, the payment phase completes and the order moves to Phase 1 if the workflow allows it. Otherwise staff move it.
- **Attention filter.** On the orders list, filter by **Needs staff review** or **Waiting for customer**.
- **Export and import.** Exports that contain phases use file version 3. On import, file sync targets and webhook subscriptions from the other installation are cleared, and the import lists them as warnings so you can choose local ones.
