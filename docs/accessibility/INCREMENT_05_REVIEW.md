# Increment 05 accessibility review

Package H reviews the workflow transfer, cart suggestions, discount codes, and policy acceptance log interfaces against the Increment 05 contract. This is a record of scoped checks against specific states, not a declaration of accessibility conformance. `Pending` means no independent result has been recorded.

## Coverage and acceptance criteria

| Interface | Page and dialog states to scan in light and dark | Keyboard, semantics, and announcements | Status |
| --- | --- | --- | --- |
| Workflow transfer | Workflow list with empty and populated selections; import file, preview, reference mapping and blocking-error states; final review and confirmation, where shown | Name row checkboxes and per-workflow controls; announce selection, export completion and preview results; identify input errors in text; maintain a predictable focus destination after advancing a step or dismissing a dialog; keep unsupported or unresolved references visible | Pending |
| Cart suggestions | Cart with offers, including add-on, upgrade and bundle examples; offer admin list, editor and destructive confirmation | Name each action for its specific item and price; announce accepted or dismissed suggestions without moving focus unnecessarily; restore focus if the active control disappears; verify labels, counters, headers, keyboard navigation, and explicit action without automatic cart changes | Pending |
| Discount codes | Admin list, editor, batch, redemption and action-dialog states; PromoCodeField in cart and wizard; link landing for saved and invalid links | Associate apply errors with the field; announce saved, copied, applied, removed or repriced states without reading a sensitive value unnecessarily; preserve input where appropriate; name row-scoped controls; confirm focus on open and return; verify filters and table headers | Pending |
| Policy acceptances | Log, Coverage and Policy updates tabs; open evidence dialog; customer Policies tab with history and version links | Exercise tablist arrow, Home and End keys and route or panel relationships; verify filters, table headers, pagination focus and text status; distinguish exact policy versions and local versus UTC time; check evidence dialog Escape and focus restoration to the launcher | Pending |

## Findings and verification

No Increment 05 implementation findings are recorded yet. Each finding will name the component or state, the observed behavior, and the disposition; a reported owner fix will be distinguished from an independent rerun.

## Evidence limits

- Component scans use the shared `pageA11y` harness for light and dark. Its jsdom environment cannot verify geometry, actual color contrast, reduced-motion playback, or a screen reader's spoken output.
- Keyboard tests should exercise the action, active element, transition, and destination, not just assert that a focusable element exists. Status messages should be available to assistive technology without moving focus unless the current control is removed or the task moves to a new step.
- Real browser verification is separate: 320 CSS px, light and dark, keyboard-only interaction, visible focus, target dimensions or sufficient spacing, no color-only meaning, rendered contrast where measured, and reduced motion. Actual browser zoom and manual screen-reader coverage are separate from viewport-based reflow and automated scans.
- No real customers, policies, discount codes, or credentials are needed for the review. Use synthetic records and report the build, role, route, viewport, theme, and tested state for browser evidence.
