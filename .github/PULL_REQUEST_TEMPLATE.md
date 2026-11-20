## Summary

<!-- What changes and why. Link the issue or ADR. -->

## Type

- [ ] feat  - [ ] fix  - [ ] security  - [ ] refactor  - [ ] docs  - [ ] chore/ci

## Verification

<!-- Commands you ran and what they showed. Say plainly what was NOT tested. -->

- [ ] `pnpm typecheck`, `pnpm lint` and the affected tests pass locally
- [ ] New behaviour has automated tests; `VERIFICATION.md` of each touched module is updated (evidence class stated honestly)

## Security (OWASP Top 10 / zero trust)

- [ ] Every new endpoint/procedure re-derives identity server-side and checks capability **and** resource scope
- [ ] Inputs validated with Zod (strict objects, bounded sizes); no `eval`, `new Function`, `child_process.exec`, `sql.raw`
- [ ] No secrets, tokens or personal data in code, logs, audit events, URLs, error messages or tests (synthetic `*.example.test` only)
- [ ] Fails closed when audit, keys or authorization data are unavailable
- [ ] New dependency? Added through `scripts/dev/add-dep.sh` with a row in `docs/engineering/DEPENDENCIES.md`
- [ ] Threat model / security review docs updated if trust boundaries changed

## Audit events

- [ ] Security- or business-relevant actions emit audit events (names listed in the module `API.md`)
- [ ] Events carry correlation IDs and safe reason codes only (no free-text user data)

## Accessibility (WCAG 2.2 AA target)

- [ ] Keyboard-complete, visible focus, labelled controls, no information by colour alone
- [ ] Works at 320–1920 px; reduced-motion respected; 44 px touch targets
- [ ] jsdom + axe component test added/updated for new UI

## Database migrations

- [ ] No schema change, **or** `pnpm db:generate` run and the generated `migrations/` files committed (forward-only)
- [ ] Migration is safe on a populated database (no destructive change without an ADR and backup note)

## Docs and records

- [ ] Module `API.md` updated
- [ ] `CHANGELOG.md` updated under **Unreleased**
- [ ] `docs/application-context/APPLICATION_CONTEXT.md` updated for substantive changes
- [ ] Session log entry added in `docs/session-logs/` (prompts, responses, results; sensitive values redacted)
