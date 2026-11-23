# 0051 — Phase tasks: what the customer must do in each phase

Status: Proposed (drafted from INCREMENT_06_CONTRACT.md D8; to be corrected against `server/modules/orders/API.md` and `server/modules/files/API.md`)

## Context
The owner asked that order phases decide what the customer must do: upload, acknowledge an administrator note, record, or respond to a document an administrator uploaded. They also asked that file and audio types can be restricted. Increment 04 introduced phases, requirements and a requirement gate ([ADR 0029](0029-workflow-phases-requirements-acknowledgements.md)).

## Decision
- **Task kinds.** Each status, grouped by phase, carries customer tasks of four kinds:

  | Kind | What the customer does |
  | --- | --- |
  | `upload` | uses the existing upload slots |
  | `acknowledge` | acknowledges workflow-defined text, or an **order note** that staff write on that order for that step |
  | `record` | records audio in the portal or uploads it. `capture` is `"record"`, `"upload"` or `"either"`; the task also sets `maxMinutes` and the allowed audio types |
  | `respond_document` | responds to a document staff uploaded. `responseMode` is `edit_in_portal` ([ADR 0052](0052-word-editing-in-portal.md)), `upload_reply` or `acknowledge`, or any of those the task allows |

  Every task has a label, a hint, required or optional, who may do it, and the allowed file types.
- **Type restriction.** `allowedTypes` is chosen per task from the platform's allowed list, with presets "Word", "PDF", "Images" and "Audio".
  - The server enforces it at upload by extension **and** by detected content type (the existing magic-byte check).
  - The client filters the file picker and explains what is accepted.
  - A task can never widen the platform list.
- **Gate.** The customer cannot leave a phase until its required tasks are complete (the existing requirement gate). Staff see task state per order and can waive a task with a reason (`orders.phase.unlock`, audited).
- **Designer.** Each status has a "Customer tasks" editor with the four kinds. Validation messages say what is wrong and where; "2 to fix" opens a list that jumps to each finding. Existing definitions stay valid.
- **Transfer.** The workflow package gains `formatVersion` 2. Import accepts 1 and 2 ([ADR 0042](0042-workflow-transfer.md)).

## Assumptions to confirm with the owner
- Waiving a task is a staff action that needs a reason. Customers cannot skip required tasks.

## Consequences
- Workflow designers can express the owner's steps without code.
- Older portals cannot import a `formatVersion` 2 package; the importing portal must be on increment 06 or later.
