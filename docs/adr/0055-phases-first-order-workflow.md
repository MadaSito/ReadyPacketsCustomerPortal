# 0055 — Phases-first order workflow: definition format 3, customer phase workspace and progress

Status: Accepted (2026-11-25, after the lead's integrated QA of increment 07 at `7c6bb71`; verification in [STATUS.md](../application-context/STATUS.md#verification-for-increment-07))

## Context
The owner asked for the order workflow to be revamped around named phases the customer sees, with a percentage per order shown in an animated progress bar (prompt 26). The owner's earlier editor is the reference for administrators.

Workflows today are status graphs. Definition formats 1 and 2 group statuses into "phases" with requirement slots, locks and gates ([ADR 0028](0028-workflow-designer.md), [ADR 0029](0029-workflow-phases-requirements-acknowledgements.md), [ADR 0051](0051-phase-tasks.md)). In code the word `phases` is already taken by those groupings.

## Decision
- **Words.** Customers and administrators read "Phase". In code the new model is `stages`, and one stage is one phase the customer sees.
- **Definition format 3.** A workflow version may carry `stages[]`, up to 20. Each stage has:
  - `key` (stable), `customerLabel` and `staffLabel`;
  - `statusKeys[]`: at least one, from the status catalogue ([ADR 0056](0056-status-catalogue-and-attention.md));
  - `actions { uploadDocuments, answerQuestions, recordAudio, uploadAudio, teamFileReview }`;
  - `governance` ([ADR 0059](0059-phase-bound-files.md)), and `folders { documents, audio }` with `fileSync` ([ADR 0061](0061-microsoft-365-file-sync.md));
  - `acknowledgement { policy: required | optional | none, message ≤ 2000 }` and `content { markdown ≤ 4000 }`;
  - `progression: next | submit_lock`;
  - `adminTasks[]` ⊆ { upload_team_document, assign_questions, review_submission, run_automation };
  - `stageActions` ([ADR 0057](0057-phase-actions-completion-rules.md)) and `completesOn: manual | payment` ([ADR 0060](0060-stripe-completion-and-payment-state.md));
  - `weight` (1–100, default 1), used for progress.

  The zod schema and TypeScript types live in `shared/`, so the editor and the server use one definition.
- **Built on what exists.** Stages compile onto the existing machinery: requirement slots, `order_phase_locks` and gates.
  - Formats 1 and 2 stay valid and show **derived stages**: one per phase group, else one per status. No data migration is needed.
  - Existing orders are never re-pinned to a new version, and nothing fires retroactively on upgrade, publish or import.
- **Runtime.** `order_stage_progress` holds the state of each stage on each order: `open | submitted | in_review | accepted | reopened`. It also holds:
  - the submission;
  - the acknowledgement evidence (policy, text hash, time, actor);
  - the review outcome;
  - the reopen reason.
- **Procedures:**
  - customers use `orders.stages.{workspace, next, submit}`;
  - staff use `review` (`orders.stage.review`);
  - administrators use `reopen` (`orders.stage.reopen`). It needs a reason of 10–500 characters, explicit confirmation and step-up.
- **Sequencing.**
  - Working ahead is refused with `STAGE_NOT_OPEN`, and completed stages stay readable.
  - **Next** advances without locking.
  - **Submit and lock** completes the stage and locks customer editing until an administrator reopens it.
- **Transitions and gates.** A status change made for a stage must be an allowed transition of the pinned version, or an audited administrator override. Nothing bypasses policy-acceptance or order-agreement gates ([ADR 0039](0039-policy-acceptance-gateway.md), [ADR 0053](0053-policy-notices-and-enforcement.md)).
- **Customer workspace.** The customer order page becomes a guided wizard showing:
  - the progress bar and the phase stepper;
  - the current phase's instructions, rendered by the safe Markdown renderer only;
  - the enabled actions, with their remaining allowances;
  - **Next** or **Submit and lock**, with the acknowledgement dialog.
- **Questions and admin tasks.**
  - Staff ask questions per order and phase in `order_questions`, and the customer answers in the append-only `order_question_answers`. Every edit is a new version. Bodies are encrypted, at most 8,000 characters and never logged. Managing questions needs `orders.questions.manage`.
  - `order_admin_tasks` records the phase's administrator checklist ticks (who and when). Unticking is audited.
- **Console order page.** A per-phase panel shows:
  - the submission;
  - review (accept, or changes requested with a note) and reopen;
  - questions with their answer history;
  - the checklist;
  - **Run phase actions**, with history.
- **Progress.**
  - **Weights.** Every phase counts by its `weight` (1–100, default 1). A phase is done when it is accepted or the order has passed it.
  - **Derived value.** floor(done weight × 100 ÷ total weight), capped at 99 until the order reaches a status of category `done`, which gives 100.
  - **Explicit value.** `orders.completion_percent`, set by a phase action or a rule.
  - **Shown value.** The higher of the derived and explicit values. It goes down only on an audited administrator reopen.
  - **Canceled orders.** A canceled order shows its last value, frozen, with the word "Canceled".
  - **Storage.** The value is stored in `orders.progress_percent` and recalculated in the same transaction as a transition, submit, review, reopen, waive or completion. Rows with no stored value are filled on read.
- **`OrderProgress` component.** It is used on the customer order page, the order list, the dashboard and the console.
  - It is a `role="progressbar"` with `aria-valuenow`, `aria-valuemin` and `aria-valuemax`, and an `aria-valuetext` such as "40 percent, phase 2 of 5: Intake".
  - It shows the number as text and a phase stepper with customer labels.
  - The fill is smooth with a count-up, and there is no animation under reduced motion.
  - It never relies on colour alone, works in both themes and reflows at 320 px.
- **Seeded workflow.** The start-up job `orders.increment07.startup` runs once at every boot and then every 10 minutes, and is idempotent.
  - A fresh install with no workflow and no order gets the format-3 "ReadyPackets standard workflow" (`readypackets_standard`) as its default. Its phases are Payment, Phase 1 intake, Phase 2 synthesis, Phase 3 review, Phase 4 delivery, Delivered and Closed.
  - On upgrade, the existing workflow is untouched. When no published version or draft has phases, the default workflow gets one draft with phases derived from its statuses, ready to review and publish.
  - Nothing is published automatically, and no order is re-pinned.
  - The same job recalculates the stored progress of orders on format-3 versions. This can lower a stale value.
- **Not built.** Free-form graph editing of phases is not built. An ordered list is clearer and keyboard-accessible, and the status graph stays under "Statuses and transitions (advanced)".

## Assumptions to confirm with the owner
- The stepper and progress bar are on for every order after upgrade, derived for older workflow versions.
- The upgrade prepares a draft only. The owner reviews and publishes it; running orders keep their version.
- The progress percentage shown is the higher of the derived and explicit values.

## As implemented: phases, progress and payment state (package B)

From the owner's [orders API](../../server/modules/orders/API.md) and the lead's QA rulings.

- **Customer Next.** It is offered only on a `next` phase that has at least one enabled customer action and does not complete on payment. Otherwise the workspace says what the phase is waiting on (`payment` or `team`), and `orders.stages.next` refuses with `STAGE_NOT_CUSTOMER_ACTIONABLE` (409).
- **Submit and lock cannot be bypassed.** On format 3, a customer status change out of a status owned by a `submit_lock` phase is refused with `STAGE_SUBMIT_REQUIRED` (409) until that phase is submitted. Cancel targets stay allowed, and staff, administrator and API actors are unaffected.
- **Request changes.** `changes_requested` needs a note (`NOTE_REQUIRED`) and keeps the lock; an administrator reopens the phase to let the customer edit.
- **Formats 1 and 2.** Derived phases are shown, but `next`, `submit`, `review` and `reopen` refuse with `STAGE_ACTION_OFF`. The legacy `orders.phases.unlock` refuses format-3 orders with `USE_STAGE_REOPEN`.
- **Passing a phase by status.** When staff move an order past a phase with a status change, the phase counts as done and the audit event `order.stage.passed_by_status` is written.
- **Background jobs.** `sessions.principalForJob(sessionId, expectedUserId, { tx })` is the only way a background job gets a principal; the archive build and the portable import both use it.
- **Gates.** `AGREEMENT_REQUIRED` and `POLICY_ACCEPTANCE_REQUIRED` are never bypassed.

## As implemented: questions and checklist (D4)

Package D, from the owner's [API](../../server/modules/orders/questions/API.md) and [admin guide](../../server/modules/orders/questions/ADMIN_GUIDE.md). Verification: see [STATUS.md](../application-context/STATUS.md#verification-for-increment-07); clarification question versioning is covered by peer-reported automated tests.

- **Procedures.** `orders.questions.{customerList, answer, list, ask, withdraw, history}` and `orders.adminTasks.{list, set}`. Staff procedures need `orders.questions.manage`; review and reopen stay in `orders.stages`.
- **Limits.** A prompt is 1–2,000 characters and an answer 1–8,000. A phase holds at most 40 questions, withdrawn ones included, and a question at most 1,000 answer versions. History is returned newest first, 10 at a time.
- **Concurrency.** Answers and checklist ticks are compare-and-set on `expectedVersion`. A stale answer is refused with `QUESTION_ANSWER_VERSION_CHANGED`, and an unavailable phase with `STAGE_NOT_OPEN`.
- **Who may write.** A viewer may read the current or a completed phase but not answer. Customer writes recheck the open, unlocked phase, a working order, live account authority and every customer-work gate. Staff cannot add questions to a submitted or completed phase without a reopen.
- **Withdrawing.** A withdrawn question keeps its answers, is hidden from the customer and takes no new answers.
- **Gate.** Before a phase advances, `assertStageQuestionsAnswered` runs inside the order-locked transaction. If any active required question has no answer, it refuses with `QUESTIONS_UNANSWERED`.
- **Review.** **Request changes** records the review but does not reopen editing.
- **Checklist.** The task keys are `upload_team_document`, `assign_questions`, `review_submission` and `run_automation`. A tick tracks work. It does not replace a review, a file check or an automation run.
- **Storage and audit.** Prompts and answers are field-encrypted with per-row AAD, and answer versions are never overwritten or deleted. The audit events are `order.question.{asked, withdrawn, answered}` and `order.admin_task.{checked, unchecked}`. They carry identifiers, phase, versions, booleans and task keys only. Question and answer text never appears in logs or the audit trail, and it is rendered as plain text, never as HTML.

## Consequences
- Administrators design phases in an editor close to the one they know, while the status graph and existing orders keep working.
- Two models coexist (format 1/2 phases and format 3 stages), and the derived-stage view hides the difference from customers.
