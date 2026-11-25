# Orders: phase questions and administrator checklist (Increment 07 D4)

All procedures require a full session, an accessible order and a phase from that order's pinned workflow. `orderId` and `questionId` mean public ULIDs. Staff procedures require `orders.questions.manage`. A viewer may read the current or a completed customer-visible phase but may not answer. Customer writes recheck current, unlocked phase, a working order, the account's live authority and all applicable customer-work gates. Staff can read question history for any pinned phase; staff cannot write questions into a submitted or completed phase without a reopen. Checklist writes require that the pinned phase defines the task and the order is writable.

| `orders.questions` procedure | Input | Result |
| --- | --- | --- |
| `customerList` | `{ orderId, stageKey }` | `{ canAnswer, questions: CustomerQuestion[] }` (active only) |
| `answer` | `{ orderId, stageKey, questionId, body, expectedVersion }` | `{ version }`; compare against current answer version (0 before first answer), then append. Answer text: 1–8,000 characters. |
| `list` | `{ orderId, stageKey }` | `{ canManage, questions: StaffQuestion[] }` (including withdrawn) |
| `ask` | `{ orderId, stageKey, prompt, required }` | `{ questionId }`; prompt: 1–2,000 characters. |
| `withdraw` | `{ orderId, stageKey, questionId }` | `{ changed }`; retains all answers and does not allow future answers. |
| `history` | `{ orderId, stageKey, questionId, beforeVersion? }` | `{ answers: StaffAnswer[], nextBeforeVersion: number \| null }`; newest first, up to 10. |

`CustomerQuestion = { questionId, prompt, required, askedAt, latestAnswer: { version, body, answeredAt } | null }`. `StaffQuestion` adds `askedByPublicId`, `withdrawnAt`, `withdrawnByPublicId` and a staff latest answer with optional `answeredByPublicId` (null if unavailable). Dates use tRPC's existing `Date` wire contract. Text is normalized plain text and must never be rendered as HTML. There are at most 40 questions per pinned phase (including withdrawn). Versions have a maximum of 1,000 per question. A stale write reports `QUESTION_ANSWER_VERSION_CHANGED`; an unavailable phase reports `STAGE_NOT_OPEN`. Do not derive authorization from the UI.

| `orders.adminTasks` procedure | Input | Result |
| --- | --- | --- |
| `list` | `{ orderId, stageKey }` | `{ canManage, tasks: { taskKey, checkedAt, checkedByPublicId, version }[] }`; unchecked tasks have null date and actor. |
| `set` | `{ orderId, stageKey, taskKey, checked, expectedVersion }` | `{ version, changed }`; 0 denotes a task never changed, otherwise compare-and-set. |

`taskKey` is `upload_team_document`, `assign_questions`, `review_submission`, or `run_automation`. The checklist is administrator-managed, not a substitute for a real review, file check or automation run.

### Integration ports

- `assertStageQuestionsAnswered(orderId, workflowVersionId, stageKey, tx)` is called by the stage progression owner, inside the existing order-locked transaction and before advancement. Only active required questions count. Refuses with `QUESTIONS_UNANSWERED` if any has no answer. No question or answer text is returned.
- Customer: `client/src/features/orders/stages/StageQuestions.tsx` exports `StageQuestions({ orderId, stageKey, readOnly? })`. Mount only when the phase has `actions.answerQuestions`; set `readOnly` for completed phases.
- Console: `client/src/features/orders/stages/OrderPhaseConsolePanel.tsx` exports `OrderPhaseConsolePanel({ orderId, renderActions? })`; the optional phase actions slot takes a pinned stage key. Review and reopen go through `orders.stages`, which owns submission authorization, acknowledgement evidence, progress and transitions.

### Storage and audit

Question prompts and immutable answer bodies are field-encrypted with AAD `order_questions.prompt:<publicId>` and `order_question_answers.body:<publicId>`. Versions are unique per question and never overwritten or deleted by the feature. Staff changes and answer submissions emit `order.question.asked`, `order.question.withdrawn`, `order.question.answered`, `order.admin_task.checked` or `order.admin_task.unchecked` atomically. Only identifiers, phase, versions, booleans or task keys are allowed in event attributes; text is excluded from logs and audit.
