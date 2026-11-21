# Software development lifecycle

How changes to the ReadyPackets portal are proposed, verified, released and recorded. It complements
`BUILD_CONTRACT.md` (the working agreement and coding rules) and `DEPENDENCIES.md` (the dependency
register). Where this guide and the source specifications disagree, the specifications win.

This document describes process controls. It is not a certification and does not claim compliance with any
standard.

## 1. Branching and review

- **Trunk-based.** `main` is always releasable. Work happens on short-lived branches
  (`feat/…`, `fix/…`, `security/…`, `docs/…`, `chore/…`) that live days, not weeks, and merge by pull request.
- **Protect `main`** (repository settings — must be configured by an administrator):
  - require a pull request; no direct pushes, no force-pushes, no branch deletion;
  - require at least one approving review, and a Code Owner review (`.github/CODEOWNERS` — replace the
    placeholder handles first); dismiss stale approvals when new commits are pushed;
  - require the status checks `ci / typecheck + lint`, `ci / tests (node + jsdom, MySQL 8.4)`,
    `ci / build (standard + preview) + migration check`, `ci / portable golden fixture + schemas`,
    `security / CodeQL (javascript-typescript)`, `security / pnpm audit (production, fail on high)`,
    `security / Secret scanning (gitleaks)` and, on pull requests, `security / Dependency review`;
  - require branches to be up to date before merging; require linear history (squash or rebase merge);
  - enable GitHub secret scanning with push protection, Dependabot alerts and private vulnerability reporting.
- **Signed commits are recommended** (SSH or GPG signing, "Require signed commits" once every contributor
  has signing configured).
- **Conventional commits**: `type(scope): summary` — `feat`, `fix`, `security`, `refactor`, `docs`, `test`,
  `chore`, `ci`. One logical change per commit. Commits made with assistance carry the required trailer.
- Security-sensitive paths (HTTP edge, security primitives, config, identity, assurance, audit, SIEM,
  portable, capabilities, migrations, deploy, CI) require a security reviewer (see CODEOWNERS).

## 2. Versioning and changelog

- **Semantic Versioning** (`MAJOR.MINOR.PATCH`). While the version is `0.x`, minor releases may contain
  breaking changes; they are called out under **Changed/Removed** in the changelog. Breaking changes to the
  portable package contract, the database contract or public HTTP/tRPC behaviour require an ADR in
  `docs/adr/`.
- `CHANGELOG.md` follows Keep a Changelog. Every user-visible or operator-visible change adds a line under
  **[Unreleased]** in the same pull request. Security fixes are listed under **Security** (with an advisory
  link once disclosed).
- The application version lives in `package.json` `version`; the release tag is `vX.Y.Z` on `main`.

## 3. Release procedure

1. Confirm `main` is green on every required check, including the latest scheduled security run.
2. Review open Dependabot and code-scanning alerts; nothing high or critical may be open without a recorded,
   time-boxed exception in the release notes.
3. Move **[Unreleased]** entries into a new `## [X.Y.Z] - YYYY-MM-DD` section; bump `package.json` `version`;
   open a release pull request; merge after review.
4. Create an annotated, signed tag `vX.Y.Z` on the merge commit and publish a GitHub release with the
   changelog section and the CycloneDX SBOM artifact from the `security` workflow.
5. Operators install from the tagged source with the frozen lockfile (`pnpm install --frozen-lockfile`),
   build with `pnpm build`, apply migrations with `pnpm db:migrate`, and follow `deploy/README.md`.
6. Record the release in the session log and update `docs/application-context/APPLICATION_CONTEXT.md`.

### Anti-downgrade

- Releases and migrations are **forward-only**. Never install an older release over a newer database, and
  never "fix" a release by reverting migrations; ship a new forward-only migration instead.
- Restoring an old backup can rewind security state (revocations, spent MFA/reset codes, session families,
  key history, anti-replay ledgers). See `docs/source-specs/ARCHITECTURE.md` §7.3. An application version
  floor alone does not prevent that; recovery must reconcile current security state before traffic, using
  code from a trusted approved release, never executables taken from an archive.
- Status: the installer's anti-downgrade floor and update verification are **not yet implemented**
  (requirement MP-10.4 in `docs/verification/REQUIREMENTS_REGISTER.md`). Until they are, operators must check
  the target tag is newer than the installed version before upgrading.

## 4. Dependency policy

- Add dependencies only through `scripts/dev/add-dep.sh`, and only when the standard library or an existing
  dependency cannot reasonably do the job. Each addition gets a row in
  [`DEPENDENCIES.md`](DEPENDENCIES.md): why, licence, alternatives rejected.
- Exact versions (`save-exact=true`) and a committed `pnpm-lock.yaml`; CI installs with
  `--frozen-lockfile`. `engine-strict=true` pins Node 22 LTS.
- Native installer pin changes must update each version and both architecture-specific hashes together in
  `deploy/auto-install.sh`. Match Node SHA-256 values to the Linux x64 and arm64 archives listed in the
  corresponding `nodejs.org` `SHASUMS256.txt`. Verify the npm registry release tarballs for
  `@pnpm/exe.linux-x64` and `@pnpm/exe.linux-arm64`, then record their SHA-512 hex digests. Keep pnpm aligned
  with `package.json`'s `packageManager` and the lockfile; update the version checks in
  `scripts/ci/native-install-smoke.sh`. Use the native workflow to exercise the changed pins.
- Install/build scripts may run only for the reviewed packages listed in `pnpm-workspace.yaml`
  (`allowBuilds`).
- Dependabot opens grouped weekly minor/patch PRs and individual major PRs for npm, and weekly PRs for GitHub
  Actions. Each update is reviewed like any other change; nothing auto-merges.
- `pnpm audit --prod` must show no high or critical advisories; dependency review blocks PRs that introduce
  high-severity vulnerabilities. A CycloneDX SBOM is produced on `main` and on the weekly schedule.
- Third-party GitHub Actions are to be pinned by full commit SHA; the current workflows use official major
  tags with `TODO(pin)` markers until each SHA is confirmed.
- No runtime dependency on a hosted AI or builder service.

## 5. Secure coding rules (summary of BUILD_CONTRACT.md §2 and §5)

- **Zero trust:** identity is re-derived from server-side session state on every request; every list,
  detail, search, export, upload, download and job re-checks capability **and** resource scope in the
  service. Client checks are cosmetic. Hidden records answer `NOT_FOUND`.
- **Local authentication with mandatory MFA** is the only active sign-in method; every other provider is off
  by default and shown as not configured until fully configured.
- **Fail closed:** if durable audit, key material, schema contract or authorization data is unavailable, the
  privileged action does not happen. High-impact writes call `audit.record(event, tx)` inside the transaction.
- **Validation:** Zod with explicit bounds; `z.strictObject` for mutations; NFC where identity matters;
  bounded cursor pagination (≤ 100); allowlisted sort/filter columns.
- **No dynamic code or shell strings:** no `eval`, `new Function`, `child_process.exec`, `sql.raw`, sourced
  config or admin-supplied HTML/scripts; `execFile`/`spawn` with argument arrays only.
- **Secrets:** never in code, logs, audit, URLs, exports, error messages or tests. Sensitive columns are
  encrypted with context binding; single-use tokens are stored only as hashes; tests use synthetic
  `*.example.test` data.
- **Errors:** throw `DomainError` with fixed reason codes and safe sentences; nothing else reaches clients.
  Authentication failures are uniform in message and timing.
- **Logging and audit:** `deps.logger` only (never `console.*`), fixed dotted event names, `UPPER_SNAKE`
  reason codes, allowlisted attributes, `publicId` references, automatic correlation identifiers.
- **Client:** no web storage or cookies from feature code, no `dangerouslySetInnerHTML`, design-system
  components and semantic tokens only; WCAG 2.2 AA target, 320–1920 px, keyboard-complete.
- **Honesty:** never fabricate evidence or claim certifications; `unknown` outcomes stay `unknown`.

## 6. Definition of done

A change is done when:

1. The requirement is implemented, or recorded as a target/limitation in the module `VERIFICATION.md`.
2. Typecheck, lint and tests pass locally for the touched paths, and every required CI check is green.
3. Tests cover the positive path, negative authorization (other customer, revoked grant, wrong role,
   remediation session, missing step-up, locked resource, tampered identifier), validation and failure
   paths; high-impact writes are proven to be audited transactionally.
4. UI changes include a jsdom component test with an `axe-core` check and work from 320 px to 1920 px.
5. Schema changes include committed forward-only migrations (`pnpm db:generate`; CI fails on drift).
6. `API.md`, `VERIFICATION.md`, `CHANGELOG.md` (Unreleased), the application context file and the session
   log are updated as applicable.
7. The pull request template checklist is complete and a reviewer (and Code Owner where required) approved.

## 7. Session logs and application context

- **Session logs** — `docs/session-logs/`: one file per working session named `YYYY-MM-DD-session-NN.md`
  recording the prompts received, the responses given and the results (commits, tests run and their
  outcome, open items). Redact secrets, tokens, credentials and personal data. Add a row to
  `docs/session-logs/README.md` for each new file (newest last). Commit the log with, or right after, the
  session's work.
- **Application context** — `docs/application-context/APPLICATION_CONTEXT.md`: the living description of the
  product, architecture, deployment model, module status and key decisions for anyone continuing the work.
  Update it in the same pull request as any substantive change (new module, changed trust boundary, new
  integration, release). It describes intent and current state; it is not a guarantee.
- Both folders are committed to the repository and pushed with the regular version-controlled history.

## 8. Continuous integration reference

| Workflow | Trigger | What it checks |
| --- | --- | --- |
| `.github/workflows/ci.yml` | push to `main`, pull requests, manual | frozen install; TypeScript 7 typecheck; ESLint; node and jsdom tests against a MySQL 8.4 service; standard and preview builds; migration drift (`db:generate` must not change `migrations/`); portable golden fixture and JSON Schemas regenerate byte-identically and verify with the standalone CLI |
| `.github/workflows/security.yml` | push to `main`, pull requests, weekly, manual | CodeQL (`security-extended`); dependency review (PRs, fail on high); `pnpm audit --prod` (fail on high); gitleaks over full history; CycloneDX SBOM artifact (non-PR runs) |
| `.github/workflows/native-install.yml` | push to `main`, pull requests, manual | prepares disposable Ubuntu 26.04 amd64/arm64 runners; exercises first install, repeat install, host validation and self-signed TLS; a separate local Pebble ACME job exercises certificate issuance, renewal and switching modes. Verification uses synthetic data and masks the temporary admin password in CI output. It does not exercise the live Let's Encrypt service. |

Workflows use `contents: read` by default (CodeQL additionally `security-events: write`), never persist
checkout credentials and need no repository secrets.

Notes on how the checks behave on this repository:

- **MySQL client tools.** The test job installs the Oracle MySQL 8.4 client from the vendor APT repository
  (signing key fingerprint checked before it is trusted), because the backup module calls `mysqldump` /
  `mysql` 8.4 and the hosted runner image ships 8.0. This mirrors the install requirement in
  `docs/operations/INSTALL.md`.
- **CodeQL without code scanning.** GitHub accepts code-scanning uploads only on public repositories or
  private ones with GitHub Code Security. Until the repository variable `CODE_SCANNING_ENABLED` is set to
  `true`, the analysis still runs on every push and pull request, the SARIF file is kept as a workflow
  artifact for 30 days, and `scripts/ci/sarif-gate.mjs` fails the job on any finding with
  `security-severity` 7.0 or higher. Dependency review needs the same GitHub feature and is skipped until
  the variable is set; `pnpm audit --prod` runs in every case.
- **Reviewed exceptions.** `.github/codeql-baseline.json` lists CodeQL findings accepted after review, each
  with a written justification; an entry that no longer matches a finding fails the gate so it gets removed.
  On pull requests CodeQL reports only findings on the changed lines, so unmatched entries are listed
  without failing there; the complete analysis on `main` enforces them.
  `.gitleaksignore` lists exact gitleaks fingerprints of synthetic test fixtures. Adding to either file is a
  security-relevant change and needs the same review as code.
