# 0055 — Phases-first order workflow: definition format 3, customer phase workspace and progress

Status: Proposed (drafted from INCREMENT_07_CONTRACT.md; to be corrected against the owners' API.md as packages land)

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
  - **Derived value.** The weight of completed actionable stages ÷ the weight of all actionable stages. A status of category `done` gives 100.
  - **Explicit value.** `orders.completion_percent`, set by a phase action or a rule.
  - **Shown value.** The higher of the two. It goes down only on an audited administrator reopen.
  - **Canceled orders.** A canceled order shows its last value, frozen, with the word "Canceled".
  - **Storage.** The value is stored in `orders.progress_percent` and recalculated in the same transaction as a transition, submit, review, reopen, waive or completion. Old orders are filled on first read.
- **`OrderProgress` component.** It is used on the customer order page, the order list, the dashboard and the console.
  - It is a `role="progressbar"` with `aria-valuenow`, `aria-valuemin` and `aria-valuemax`, and an `aria-valuetext` such as "40 percent, phase 2 of 5: Intake".
  - It shows the number as text and a phase stepper with customer labels.
  - The fill is smooth with a count-up, and there is no animation under reduced motion.
  - It never relies on colour alone, works in both themes and reflows at 320 px.
- **Seeded workflow.** New installs get a published format-3 "ReadyPackets standard workflow": Payment confirmed, Phase 1 intake, Phase 2 synthesis, Phase 3 review, Phase 4 delivery, Delivered, Closed. On upgrade the existing workflow is untouched. A format-3 **draft** of the standard workflow is prepared, and `/admin/workflows` says "Phases version ready to review and publish".
- **Not built.** Free-form graph editing of phases is not built. An ordered list is clearer and keyboard-accessible, and the status graph stays under "Statuses and transitions (advanced)".

## Assumptions to confirm with the owner
- The stepper and progress bar are on for every order after upgrade, derived for older workflow versions.
- The upgrade prepares a draft only. The owner reviews and publishes it; running orders keep their version.
- The progress percentage shown is the higher of the derived and explicit values.

## As implemented: questions and checklist (D4)

Package D, from the owner's [API](../../server/modules/orders/questions/API.md) and [admin guide](../../server/modules/orders/questions/ADMIN_GUIDE.md). Verification: **PENDING-LEAD**.

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
