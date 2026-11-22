# Increment 05 accessibility review

Package H reviews the workflow transfer, cart suggestions, discount codes, and policy acceptance log interfaces against the Increment 05 contract. This is a record of scoped checks against specific states, not a declaration of accessibility conformance. `Pending` means no independent result has been recorded.

## Coverage and acceptance criteria

| Interface | Page and dialog states to scan in light and dark | Keyboard, semantics, and announcements | Status |
| --- | --- | --- | --- |
| Workflow transfer | Workflow list with empty and populated selections; import file, preview, reference mapping and blocking-error states; final review and confirmation, where shown | Name row checkboxes and per-workflow controls; announce selection, export completion and preview results; identify input errors in text; maintain a predictable focus destination after advancing a step or dismissing a dialog; keep unsupported or unresolved references visible | Initial independent run: 17 passed. Both-theme scans for export, file, mapping, confirm and step-up; browser reflow and follow-up below pending. |
| Cart suggestions | Cart with offers, including add-on, upgrade and bundle examples; offer admin list, editor and destructive confirmation | Name each action for its specific item and price; announce accepted or dismissed suggestions without moving focus unnecessarily; restore focus if the active control disappears; verify labels, counters, headers, keyboard navigation, and explicit action without automatic cart changes | Pending |
| Discount codes | Admin list, editor, batch, redemption and action-dialog states; PromoCodeField in cart and wizard; link landing for saved and invalid links | Associate apply errors with the field; announce saved, copied, applied, removed or repriced states without reading a sensitive value unnecessarily; preserve input where appropriate; name row-scoped controls; confirm focus on open and return; verify filters and table headers | Initial `PromoCodeField` and link landing suite: 25 passed, including both-theme component scans. Host integrations, admin pages, and browser reflow pending. |
| Policy acceptances | Log, Coverage and Policy updates tabs; open evidence dialog; customer Policies tab with history and version links | Exercise tablist arrow, Home and End keys and route or panel relationships; verify filters, table headers, pagination focus and text status; distinguish exact policy versions and local versus UTC time; check evidence dialog Escape and focus restoration to the launcher | Pending |

## Findings and verification

| Area | Observed behavior | Disposition |
| --- | --- | --- |
| Shared DataTable: checkbox target and selection semantics | Initial checkbox target was 20 CSS px; its 44 px outer wrapper was not interactive. Row state also used a redundant selection attribute on the ordinary table row. | Foundation changed the Radix root to the 44 px interactive target with a 20 px visual, and row styling uses a data attribute. Independent `increment05.test.tsx`: 1 passed, including named checkboxes, mixed state and live selection count. Actual browser target dimensions were not independently measured. |
| Workflow import: identifying incomplete fields | The review step reports a global missing-choice or missing-mapping message but does not associate it with individual invalid controls or focus the first one. | Reported to workflow UI owner. The initial keyboard test verifies step focus, blocking and return to the launcher, not field-level error association. |
| PromoCodeField: blank submission and saved-code action | Blank submission does not update the live region. The saved-code action included the entire code in nonwrapping button text, which could expand past its container with a maximum-length code. | Reported to Promotions UI owner. Treat the width issue as a source-level risk until verified in a browser. |
| Promotion link: forgetting a code | The action unmounts the active button without a stable focus destination and the replacement callout is not live. | Reported to Promotions UI owner. The initial component suite verifies that the code is cleared, not keyboard focus after removal. |

## Evidence limits

- Component scans use the shared `pageA11y` harness for light and dark. Its jsdom environment cannot verify geometry, actual color contrast, reduced-motion playback, or a screen reader's spoken output.
- Keyboard tests should exercise the action, active element, transition, and destination, not just assert that a focusable element exists. Status messages should be available to assistive technology without moving focus unless the current control is removed or the task moves to a new step.
- Real browser verification is separate: 320 CSS px, light and dark, keyboard-only interaction, visible focus, target dimensions or sufficient spacing, no color-only meaning, rendered contrast where measured, and reduced motion. Actual browser zoom and manual screen-reader coverage are separate from viewport-based reflow and automated scans.
- No real customers, policies, discount codes, or credentials are needed for the review. Use synthetic records and report the build, role, route, viewport, theme, and tested state for browser evidence.
