# 0012 — Toolchain: TypeScript 7 for type checking, TypeScript 6 for lint

Status: Accepted (2026-11-20)

## Context
typescript-eslint did not yet accept the TypeScript 7 native compiler at the time of the build, while the
native compiler type-checks the whole project in under a second on the build host.

## Decision
`typescript` (6.x) is installed for the linter's parser; `typescript7` is an alias used by `pnpm typecheck`.
Both run in continuous integration. When the linter supports version 7 the alias is removed.
