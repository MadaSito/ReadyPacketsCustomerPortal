# 0037 — Accessibility target WCAG 2.2 AA; customer sidebar navigation and visible theme control

Status: Accepted (2026-11-21; owner confirmation requested)

## Context
The owner asked for an accessible ("ADA compliant") site, better customer navigation, a visible light / dark / system choice and full responsiveness.

## Decision
- The engineering target is WCAG 2.2 level AA in both themes. Every page has an automated axe check; a real-browser check covers every route at several widths, both themes and 400 % zoom; a manual checklist records what was and was not checked.
- The customer area uses a grouped left sidebar on wide screens, a drawer on medium screens and a bottom bar on phones. The theme control is a three-way segmented control.
- A public Accessibility page states the target, known limitations and how to report a barrier.

## Consequences
Automated checks find only part of accessibility defects. We do not claim certification; an independent audit with assistive technology is recommended before making a public conformance claim.
