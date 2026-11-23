# Customer tasks and the order agreement (administrators)

Owner: orders module. Increment 06 (D8, D10, D14).

## Customer tasks per status

Open **Workflows** (`/admin/workflows`), edit a draft and go to **Phases and requirements**. For each status you can add tasks the customer (or your team) must finish before the order leaves that status:

- **Upload**: a named file slot. Choose the accepted file types with the presets (Word, PDF, Images, Audio) or type extensions.
- **Recording** (**Add recording**): an audio task. Choose **How the customer adds audio** (record in the portal, upload a file, or either) and **Longest recording** (1 to 120 minutes). The customer's Record link opens the recorder on the order's Files tab.
- **Acknowledgement**: text the customer confirms. With **Text comes from: A note on each order**, your team writes a note on each order (Write note / Edit note on the order's Phases tab). The customer cannot acknowledge until the note exists, and the note cannot change after it has been acknowledged.
- **Document to respond to** (**Add document task**, up to 5 per status): your team uploads the document on the order; the customer responds by any of the modes you allow:
  - **Edit in the portal** (needs Word, docx, in the accepted types);
  - **Upload a reply**;
  - **Acknowledge** ("I have read this document").

Existing workflows keep working unchanged; tasks are optional.

### Waiving a task

Staff with the phase unlock permission can choose **Waive** on a task and give a reason (10 to 500 characters). The customer sees "Waived by our team". The reason is kept as an internal note and the waiver is recorded in the audit log (`order.task.waived`).

### Finding problems in a draft

The designer header shows how many problems block publishing, for example **2 to fix**. Choose it to open the list of problems. **Show** next to each one opens the step that owns it and moves focus to the field. If there is no single field (for example a status with no way out), focus moves to that step's problem list.

## Workflow export and import switch

Export and import are on by default. The switch **Workflow export and import** is on the Workflows page. See [Workflow export and import](./WORKFLOW_TRANSFER.md).

## Order agreement gate

Off by default, because a wrong setting can stop customers from ordering. Configure it on **Policies** (`/admin/policies#order-agreement`, card owned by compliance): choose a published policy, whether it applies before placing an order and/or before working on an order, the signature mode (checkbox or typed name) and whether to ask again on a new policy version.

When it applies, the customer sees the agreement in place (on the new-order page, or "Your tasks are paused until you accept the agreement" on the order) and continues after accepting. Staff and API integrations are not blocked. If the stored setting is damaged, customer actions it covers are refused with a "temporarily unavailable" message rather than allowed.
