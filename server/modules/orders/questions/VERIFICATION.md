# Phase work verification (Increment 07 D4)

| Requirement | Evidence |
| --- | --- |
| Full sessions, capabilities, scoped orders and question IDs; grant, future and closed-phase refusal; lock order and revalidation | `scripts/dev/test.sh server/modules/orders/questions.test.ts` uses a real MySQL database and caller guards, a stubbed stage resolver and agreement guard, and the shared test identity service. |
| Required questions block progression; past answers immutable, encrypted and scoped; withdrawn questions remain in console only | Same suite exercises the progression port and inspects stored ciphertext and audit attributes. |
| Checklist accepts only configured keys; stale changes refused; audit rollback and check/untick events | Same MySQL suite; failure is injected on the audit port, which must roll back the state change. |
| Format-1/2 orders without an explicit phase model keep derived stages without enabling new actions | Same suite tests legacy phase derivation. |
| Pinned format-3 order: required answer, attention, submit, changes requested, step-up reopen and accept | Same MySQL suite runs the actual Orders router and phase workspace methods end to end. It uses a synthetic pinned workflow and the runtime's missing-catalogue-entry fallback to isolate D4 from D2 seed data. |
| Customer answer/version controls, text escaping, focus and read-only state | `scripts/dev/test.sh client/src/features/orders/stages/phaseWork.test.tsx`, built on tRPC fixtures, Testing Library, keyboard input and jsdom axe. |
| Console question history, checklist, request changes, explicit reopen confirmation and focus return | Same UI suite. |

## Rendered regression checklist

Use a pinned format-3 order with two phases, questions enabled on one, and a `submit_lock` phase that includes the checklist. Use separate customer, viewer, staff and administrator sessions. No production records are needed.

- In the console `Phases` tab, switch between named phases and use `Assign question` to add a required question. Verify the checklist survives reload, and an untick leaves the audit event. Confirm question text is absent from the order history and SIEM view.
- In the customer wizard, verify `Questions from our team`, first answer, edit, version and focus on the question after saving. Do not allow progression before required answers, future-phase reads or past-phase writes. A viewer can read displayed answers but cannot open an answer editor.
- Submit and lock the phase. Verify `Submission` in the console, then `Request changes`, `Reopen phase`, reason, confirmation and the actual step-up flow. Confirm the customer can edit after reopening. Verify staff without the administrator capability cannot reopen.
- Check console history pagination, withdrawn content visibility, responsive drag-free phase switching and the existing checks on a legacy order. Check 320, 768 and 1280 CSS pixels, both themes, zoom, keyboard navigation, reduced motion and visible focus without relying on color.

The fixture-backed UI suite does not validate pixel layout, contrast, a real authenticator, screen reader announcements, or the fully wired browser flow. Rendered QA is owned by Foundation; record any coverage it reports separately.
