**Version:** 2026-11-20. **Owner:** ReadyPackets. **Author:** Manus AI.
**Purpose:** a self-contained engineering instruction for rebuilding the
platform on operator-controlled infrastructure. This is a requirements
specification, not a claim that the current deployment implements or has
passed every requirement.

Use the entire prompt below with a senior implementation team or coding
agent. The companion [<u>technical
architecture</u>](https://github.com/readypackets/ReadyPackets-SiteSplit/blob/feat/direct-github-factory-launcher-20261118/docs/architecture/2026-11-20/READYPACKETS_TECHNICAL_ARCHITECTURE.md)
supplies diagrams, current-source context, detailed contracts, and
operational rationale. This prompt remains usable without the companion:
its mandatory requirements and acceptance rules are restated here.

# 1. Your role, outcome, and authority

Act as a senior full-stack architect, application-security engineer,
database/recovery engineer, accessibility specialist, and release
engineer. Recreate **ReadyPackets**, a professional customer portal,
staff workspace, administrative operations console, and independently
deployed public marketing website. Deliver working, maintainable,
self-hosted software with documented controls and genuine test
evidence—not screen mockups, placeholder APIs, or unsupported security
claims.

The highest-priority outcomes are secure local customer access, correct
order/file ownership, complete portable business-data recovery, tested
encrypted disaster recovery, and detailed correlated audit records with
advanced search and secure SIEM/syslog delivery. Core flows must work
without any third-party identity, analytics, payment, storage, or AI
provider.

Do not claim “100% secure,” “exploit-proof,” legal ADA certification,
guaranteed compatibility with arbitrary future software, or guaranteed
recovery from an untested archive. Use a versioned requirements-to-tests
register, describe residual risk, and prove the behaviors actually
exercised. Interpret “zero proof” as **evidence-based verification with
no inferred trust** unless the owner explicitly requests a reviewed
zero-knowledge cryptographic feature. Zero trust does not mean inventing
cryptography.

Source preparation and synthetic tests are not permission to access
customer data or operate a production host. Never deploy, reimage,
reinstall, uninstall, run customer imports, restore a database, change
credentials, purge retention, issue certificates, shut down Beta, or
bypass a stop rule without the applicable explicit authorization. An
uncertain mutation is a held operation, not permission to retry it.

For continuity only: as of the last recorded 20 November 2026 04:11 US
Eastern observation, the existing fresh-production application remained
on whole release 2c54c2f731f3a45837383a4bafa5c8414a607b21. Its newly
approved HTTP attempt stopped before publication. Public HTTPS,
remaining controller installation, backup and portable-transfer
acceptance were incomplete. This prompt does not authorize a third
attempt or change that state.

# 2. Non-negotiable engineering constraints

1.  The deployed application must have **no Manus runtime, SDK, OAuth,
    API, hosted asset, storage, telemetry, build plugin, or
    platform-service dependency**. Developer attribution in Git is not
    an application dependency. Provide ordinary open-source build and
    deployment tooling that another team can use independently.

2.  Use local authentication with mandatory MFA as the default. Optional
    enterprise identity must be deliberately configured and tested; it
    must not eliminate a protected local MFA break-glass path.

3.  Enforce authentication, MFA assurance, role, resource ownership,
    current grants, order locks, and policy restrictions on the server.
    Client menus and local network location never confer authority.

4.  Use operator-controlled storage and encryption-key custody. No
    secret may be committed to Git, embedded in client bundles, printed
    into logs, passed in URLs or process arguments, or included in
    analytics.

5.  Privileged OS operations belong to narrowly scoped, independently
    reviewed helpers. The application must not obtain root, broad sudo,
    arbitrary shell execution, Docker-socket access, or write access to
    installed code, unit files, trusted helper files, TLS keys, or
    security-floor records.

6.  Build an elegant responsive ReadyPackets interface using the latest
    owner-approved brand assets. Do not reuse the old logo or restore
    removed Packet 8. Do not hardcode legacy catalog/pricing
    assumptions. Target WCAG 2.2 AA across complete workflows, with
    manual assistive-technology review as well as automation.
    [<u>5</u>](https://www.w3.org/TR/WCAG22/)

7.  Integrate security into each SDLC phase. Target OWASP ASVS 5.0.0
    Level 2, with individually selected higher-assurance requirements
    for privileged administration, release trust, keys, and recovery.
    Record exact versioned requirement IDs after verifying them; do not
    fabricate an OWASP certification.
    [<u>1</u>](https://asvs.owasp.org/)

8.  Keep all prompts, user-visible responses, results, limitations,
    design decisions, application context, and release evidence version
    controlled in dedicated folders. Redact sensitive historical
    messages before publication. Push authorized changes to the selected
    private GitHub repository regularly, without force-pushing or
    weakening branch/CI protections.

# 3. Product surfaces and user experience

## Public marketing website

Deploy the public site separately from the authenticated portal. Its
**My Portal** link goes to https://my.readypackets.com/, not directly to
registration. Support clear catalog/product pages, FAQs, knowledge
content, methodology, accessible policies, contact intake, and
administration-governed content. Produce canonical URLs, sitemap, robots
rules, metadata, accurate structured data, crawlable semantic content,
and answer-oriented writing for SEO/GEO/AEO. Do not expose private
portal pages to crawlers or invent rich-result promises, reviews,
testimonials, product claims, or prices.

## Customer portal and PWA

The portal hostname serves the login/portal experience, not the full
marketing website. Default canonical hostname is my.readypackets.com;
explicit alias portal.readypackets.com redirects to it. Make domains
configurable with a reviewed controller, exact certificate coverage, and
one cookie/CSRF origin. Marketing links point back to the independent
public site where appropriate.

On desktop, use login controls on the right and a restrained
owner-configurable slideshow on the left. On mobile, prioritize the form
without obscuring it. Make **Create an account** visible and accessible.
Carousel content must be bounded plain copy and approved self-hosted
assets; never accept arbitrary admin JavaScript, HTML, CSS, or remote
login images. Respect reduced motion and provide pause/navigation
controls.

Support registration, email verification, local sign-in, MFA
enrollment/challenge and recovery-code acknowledgment, password
change/reset, profile, orders, phases/workflows, required
policies/intake, secure uploads and deliverables, messages, tickets, and
appropriate invoices/workspaces. Clearly display loading, queued,
progress, empty, failed, canceled, unknown-outcome, and completed
states. A verification spinner must have a bounded status protocol and
actionable safe diagnostics, not spin forever.

PWA installation and static-asset updates are in scope. Authenticated
pages, APIs, tokens, orders, documents, messages, and files must remain
network-only by default. Cache only approved public/static assets.
Logout and account switching must not reveal the previous user's
content. Offline authenticated data, background upload, or push require
separate device/key/revocation threat models; do not imply they exist
because a service worker is installed.

Native iOS/Android applications are Day-2 scope unless explicitly
promoted. Keep API authorization consistent; store device tokens in
platform secure storage, use self-hosted authorization/PKCE, short-lived
access tokens, rotating revocable refresh families, and verified
redirect/app-link rules. Do not expand privileged backup/key/admin
actions into mobile merely to claim parity.

## Staff and administration

All authorized customers, staff, and administrators can create an order
where business policy permits. Administrative users see all in-scope
customers/orders, not only their own created records; customers see only
owned or currently authorized shared resources. Test this distinction
with multiple synthetic roles and older paginated records.

Provide named projects/orders, a versioned catalog, controlled workflow
transitions, intake/forms, secure order files/audio/deliverables,
customer management, bounded global search, protected identifier changes
and order reassignment, file visibility, support, policies, invoices,
integrations, platform setup, backups, portable transfer, audit/incident
center, security, and system health. Changes to customer/order
identifiers must reserve retired references and respect
financial/legal/external evidence. Reassignment must be transactional
and revoke inappropriate prior access.

Password administration must offer email-reset link, securely generated
temporary password, and administrator-entered temporary password. Every
method enforces the same policy, correct local/SSO boundary, step-up,
forced next-login change, session revocation, and secret-free audit.
Sensitive values clear from UI memory on completion/close; no
administrator can retrieve a current plaintext password.

Platform setup supports an accessible wizard or safe versioned import,
preview/diff, save/test operations, configuration export, backup
settings, and integration discovery. Export nonsecret settings by
default; secret-bearing exports require a separately encrypted format
and approved custody. Configuration files are data only; never source or
execute imported environment assignments.

# 4. Technical architecture and code organization

Prefer continuity with the current stack: React 19, TypeScript, Tailwind
CSS, Vite; Node.js supported LTS, Express 5, tRPC, Zod; MySQL
8-compatible database and Drizzle ORM; Nginx and systemd for the native
VPS. Use supported patched versions selected through a
dependency/security review and locked build, not floating “latest.” Any
stack replacement requires an ADR and preservation of security/recovery
contracts.

Implement a modular monolith first, with separate feature routers,
domain services, data repositories, authorization policies, security
modules, observability, and operational controllers. Use durable
database state and bounded workers. Do not add microservices, Redis,
search engines, or cloud dependencies without a measured need and an
operator-maintainable lifecycle.

Keep interfaces explicit: browser/API contract; domain operations;
storage adapter; encrypted-key provider; audit emitter; portable
reader/writer; recovery validator; provider adapter; typed privileged
controller protocol. Use dependency injection for synthetic tests
without production credentials.

Database migrations are versioned, reviewed, resumable where necessary,
and forward-compatible. Verify a schema contract before traffic.
Preserve constraints for ownership, stable identifiers, order
dependencies, job claims, import receipts, financial uniqueness, and
idempotency. Derive current schema inventory from the selected release;
never reuse historical table/migration/test counts as acceptance.

Native deployment exposes only the necessary HTTP/HTTPS edge and
restricted SSH. API/database/storage/controllers are private. Use
least-privilege database users, host-only file ownership, reviewed
systemd restrictions and no arbitrary code writes. Container deployment
uses non-root users, read-only images, capability dropping, private
networks, separate secrets, and no host Docker socket. Unsupported
host-controller/recovery capability must be explicitly unavailable, not
simulated.

# 5. Identity, sessions, and authorization

Implement Argon2id password hashing with deployment-benchmarked
memory/time parameters; migrate approved legacy hashes only after
successful verification. Use a blocked/common/compromised-password
policy. For the rebuild, adopt a uniform **minimum 15-character**
default/safe floor, allow at least 64 characters and choose a bounded
maximum such as 128, count Unicode code points consistently, do not
silently truncate, and support password managers/paste. Avoid arbitrary
composition rules and routine expiry without compromise evidence. A
change from an existing lower floor is a reviewed policy transition, not
an automatic production edit. NIST distinguishes 15 characters for
single-factor passwords and at least eight when used only within MFA;
ReadyPackets deliberately chooses the stronger uniform target.
[<u>4</u>](https://pages.nist.gov/800-63-4/sp800-63b.html)

Require local TOTP enrollment, successful challenge, bounded retries,
replay prevention, and single-use hashed recovery codes. Require
explicit recovery-code acknowledgment without interpreting copy or focus
events as consent. Provide phishing-resistant WebAuthn/passkeys as a
prioritized target, with reviewed enrollment/recovery and RP-ID/origin
validation; do not label TOTP phishing-resistant.
[<u>4</u>](https://pages.nist.gov/800-63-4/sp800-63b.html)

Use signed host-only \_\_Host- cookies with Secure, HttpOnly, Path=/, no
Domain, and a reviewed SameSite policy; enforce CSRF with session
binding and strict origin checks. Use revocable server-side sessions,
idle/absolute lifetimes, session rotation on login/privilege/password
changes, and fresh step-up for high-impact operations. Do not store
browser bearer credentials in local storage.

Implement a single account-transition service that derives the next
incomplete prerequisite. A new account requiring both MFA and password
change must have narrowly scoped remediation permissions without
route-to-route redirect loops. No remediation session may view
customer/admin data. Prevent MFA bypass through magic links, SSO
fallback, API batching, password reset, account conversion, stale
sessions, or direct HTTP calls.

Enterprise SAML/Entra integration is optional and disabled until
configured. Validate signatures, issuer, audience, recipient, timing,
request binding, replay, and approved MFA assurance. No silent
email-based account linking or role escalation. Local-to-SSO and
SSO-to-local conversions require explicit authorization, verified
binding, step-up, revocation, and audit. Retain a separately protected
local MFA administrator.

Authorization must distinguish role/capability and resource scope. Apply
it to every list, detail, search, share, export, upload, download,
workflow, admin action, background task, and controller request. Reject
horizontal and vertical privilege escalation, mass assignment, stale
grants, cross-order uploads, owner tampering, and editable operations on
read-only imported orders.

# 6. Application, file, and integration defenses

Implement strict schemas, contextual output encoding, parameterized SQL,
bounded query/body/file sizes, trusted proxy configuration, safe host
validation, rate limits and resource quotas. Apply route-specific nonce
CSP and tested browser headers; no blanket unsafe-inline/eval. Stage
HSTS only after trustworthy HTTPS, and do not preload/include unrelated
subdomains without the owner-approved domain posture.

Uploads require extension and content/magic-byte agreement, safe
handling of signature-less text, no executable/scriptable formats,
bounded sizes/counts, malware/quarantine policy, and authorization. WebM
audio/video classification must be normalized consistently across
upload, export, verification, and import; test WebM, MP4/M4A, Ogg and
browser differences. File storage is private, outside the web root, uses
opaque keys, and disallows path traversal, symlinks/hardlinks and
archive extraction attacks. Download handlers reauthorize the resource
and lock state and set safe attachment/nosniff behavior; tickets are
short-lived and bound to current authority.

Optional integrations include SMTP or reviewed Graph mail, SharePoint,
Stripe, and configured phase/workflow endpoints. No hardcoded secrets or
live webhook defaults. SharePoint setup accepts a site address and
securely discovers site ID, drives and permitted folders; provides
save/test/select destinations; reports least-privilege errors safely.
For new naming rules, use the first two customer first-name characters,
full last name and customer ID, plus safe order/project labels, with
Unicode/length/collision handling. Labels are display metadata, not
ownership authority; do not silently rename existing remote evidence or
expose personal folder names in logs.

Outbound destinations require egress/SSRF policy: allowlisted
schemes/hosts/ports, resolution and redirect validation, no
metadata/private/loopback targets unless explicitly configured as an
operator-owned approved destination. Provider credentials are encrypted
and server-side. Separate security-approved private SIEM destinations
from arbitrary customer-provided URLs.

Use signed inbound webhooks with narrow raw-body routes,
timestamps/replay protections, durable authenticated inbox reservations,
payload hashes and asynchronous processing. Use transactional outboxes
and stable idempotency keys for outbound effects. Handle duplicate,
reordered, delayed, timed-out and partially accepted provider operations
through receipts and reconciliation; never advertise generic
exactly-once execution.

Analytics is optional and off by default. Support deliberately
configured Clarity and/or approved PostHog. Enforce opt-in/revoke, route
exclusion, masked inputs, bounded identifiers/destinations, no arbitrary
admin snippets, no replay/autocapture on sensitive surfaces and no
customer/order/token payloads. Self-hosted PostHog is a separate target
configuration requiring review. A disabled provider must cause no
provider network request.

# 7. Portable customers, orders, and files — mandatory design

Business records must be recoverable without the original hostname,
runtime database, SaaS account, database primary keys, or old
application encryption keys. **This does not mean every future product
automatically accepts the package.** Provide a documented open data
contract, independent verifier/extractor, and adapter interface so
another system can read the data and map it safely.

## Contract and profiles

Publish versioned UTF-8 JSON/JSONL schemas, field dictionaries,
enumerations, examples, file manifests, migration rules, compatibility
policy, and test vectors. Use standard non-executable archive storage
and a documented authenticated encryption envelope. Choose a release
version through an ADR; a next-generation draft must not be represented
as compatible with existing portable v1/v2 readers until adapters pass.

Support selectable single/multiple/all customers, single/multiple/all
complete orders, and all or selected files within a justified dependency
closure. Profiles include customer-only, complete-order-with-files,
all-core-business, and separately versioned historical evidence. A
file-only package must reference an existing verified target order and
owner; an orphan is never silently created. Preserve source dates,
currency/minor-unit values, source identifiers, required names, status
history, file metadata, provenance, read-only locks and correct
ownership.

Use stable portable identifiers distinct from installation-local keys
and editable business references. Include source installation identity,
package ID, export time, consistent snapshot reference,
producer/contract versions, required reader capabilities, record counts,
scope, dependency graph, exclusions, and complete per-file sizes/SHA-256
hashes. Keep package digest, canonical manifest/signature bytes, and
plaintext versus ciphertext integrity semantics precise and testable.

Passwords/hashes, MFA secrets/codes, session/refresh/reset tokens, SSO
bindings, API/provider secrets, executable hooks, code, local absolute
paths and privileged host configuration **must never travel in a
business portable package**. Imported customer identities need verified
target activation and local MFA. Do not auto-link by email or silently
grant the target's administrator role.

Design historical-extension modules for invoices/payment evidence, legal
acceptances, intake, messages, custom fields, and
integration/workflow/file-access history. Preserve these as
non-executable historical evidence with original provenance; never
replay payment, email, acceptance, workflow or provider jobs. Declare
omissions explicitly. If a required extension is unsupported, refuse
acceptance; optional unknown extensions may be retained as uninterpreted
evidence under size/privacy limits, not treated as trusted code or
silently discarded.

## Secure export/import execution

Export from a consistent record snapshot with a captured authorized file
inventory. Hash actual source bytes and bind package identity before
publication. Encrypt to approved recipients or a protected passphrase;
use reviewed cryptographic libraries and documented parameters. Keep
recovery keys outside Git and separate from archives. A checksum proves
integrity only; add trusted signatures where source authenticity is
required and never trust a signing key merely because it arrived in the
same archive.

Import into immutable private quarantine. Verify encryption
authentication, archive safety/limits, contract/schema, required
modules, relationships, source mappings, MIME policy, every file
size/hash and all authorization before mutation. Default to dry run,
collision refusal, no overwrite, no implicit email matching, and
read-only orders unless an explicit approved operation chooses editable.

Bind approval to the exact package and plan hashes, target installation,
scope, mapping decisions, current authorization, expiry and one-time
operation ID. Seal reviewed input ownership for its full lifetime; do
not merely hash a mutable pathname once. Preserve restrict-SUID/SGID
controls; new service storage uses reviewed ordinary service-group
permissions without requiring setgid. No recursive chmod/chown or
weakening of existing custody is permitted as an import shortcut.

Use durable import reservations, unique source-to-target mappings,
fenced jobs, atomic business/audit/receipt writes, and a recoverable
prepared/committed/finalized state machine. Database and object storage
are not one transaction: inaccessible staged objects must be tracked and
finalized or cleaned only after exact ownership and durable-state proof.
A timeout/missing response is unknown until reconciled; refuse blind
replay or automatic rollback.

Acceptance requires reconciled counts, owner/order/file relationships,
dates, hashes, admin visibility, customer isolation, lock behavior, and
actual authorized downloads. Retain source and independently usable
export until acceptance and explicit retention/shutdown decisions.
Partial data transfer is not full recovery and never authorizes deletion
of excluded history.

## Required portability evidence

Test cross-hostname and cross-encryption-key roundtrips; old-version
reader adapters; a minimal reference importer into a different empty
data model; multiple/all selections; preserved unknown optional
evidence; corrupt/missing/extra files; tampered manifest/envelope;
archive bombs/traversal/links; duplicate/replay/collision cases; changed
plan/package; missing owner; malformed dates/currency; unsupported
required modules; lock behavior; stale jobs; and crash before/after each
durable boundary. Compare independently downloaded bytes to source
hashes using synthetic fixtures only unless real-data authorization
exists.

# 8. Backup, restore, corruption, and key custody

Portable business transfer is **not full disaster recovery**. Provide
consistent full backups of database, private object inventory/bytes,
approved configuration evidence, encryption/index key custody references
and release/schema provenance. Secrets included for disaster recovery
require a separately encrypted envelope and strict access. Never
silently fall back to plaintext when requested encryption fails.

Maintain independent off-host copies and at least one immutable/offline
copy, separate recovery-key custody, expiration/retention policy, legal
holds, and verifiable restoration instructions. Define proposed RPO/RTO
with the owner, then measure achieved data age and duration through
isolated restores. Merely creating an archive or passing gzip/tar
structure checks does not prove semantic recovery.

Full restore replaces a dataset; portable import appends approved
business scope; forward repair corrects compatible state. Implement safe
CLI/wizard separation and exact target/release/package confirmation. No
generic restore-to-production button, arbitrary root shell, restore over
a populated target, or inherited historical credential activation.

Never rewind spent MFA codes, reset tokens, revoked sessions/refresh
families, identity changes, payment/webhook receipts, security floor, or
secret history. Independently retain security continuity evidence.
Restore executable helpers/code only from a trusted current approved
release—not blindly from a backup. If security continuity cannot be
proved, recover business data into quarantine with old authentication
and provider jobs disabled, establish a trusted fresh local MFA
administrator through an approved bootstrap, and reactivate customers
through verified processes. Missing current revocation evidence is not
permission to reactivate old credentials.

Create documented corruption handling for partial database damage,
missing files, tampered archives, unavailable keys, broken provider
copies, incompatible versions, and unavailable security history. Stop,
preserve evidence, isolate the fault, validate independent copies, then
perform reviewed forward recovery. Do not run repeated installers or
mutate security floors as a repair.

Retention jobs can delete data and provider copies; use exact owned
manifests, previews, retention holds, durable results and explicit
activation. No timer should start unexpectedly during installation or
review. Verify backup, export, independent extraction, restore and
authorized-download acceptance separately.

# 9. Advanced logging, audit center, and secure forwarding

## Canonical event model

Create one versioned allowlisted event envelope for security, business
activity, admin mutation, system/service, file access, integrations,
jobs, backup/recovery, portable transfer and releases. Align with the
OpenTelemetry model for timestamps, observed timestamps, trace/span IDs,
severity and resources; maintain documented syslog mappings.
[<u>2</u>](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
[<u>3</u>](https://www.rfc-editor.org/rfc/rfc5425)

Required fields include schema version, event ID, UTC occurred/observed
times, severity number/text, category, fixed event name, action,
outcome, reason/error code, installation/service/version, actor
pseudonym and verified role, resource type and permitted pseudonymous
reference, request/trace/span/correlation IDs, parent correlation,
job/package/import/delivery IDs where appropriate, and bounded safe
metrics such as duration/counts. Do not mistake a correlation ID for
authority or trust arbitrary inbound baggage.

Generate trusted server request IDs and propagate sanitized context
through asynchronous work, controllers, provider inbox/outbox and
recovery jobs. Keep long-lived workflow correlation separate from
request trace IDs. Correlate events across streams through indexed
fields, not expensive arbitrary searches of JSON metadata. Logs must
record attempts and completed/failed/unknown outcomes truthfully; do not
report publication success merely because an attempt began.

Redact/validate before persistence, transport and display. Never log
passwords, MFA material, reset/session tokens, credentials, database
connection strings, archive passphrases, private keys, raw
SQL/body/error dumps, filenames/customer content or unsafe exception
getters. Sensitive local identity/IP access may be justified only under
controlled retention, restricted access and explicit classification.
External forwarding uses a stricter privacy-safe projection. Pseudonyms
remain potentially personal data; do not describe hashes as anonymous by
default.
[<u>6</u>](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)

## Durable audit and filtering

Commit high-impact business changes with durable audit intent/result in
the same transaction wherever possible. Protect mandatory audit
availability: deny unauditable high-impact writes if local durable
evidence cannot be committed, with documented safe error semantics;
ordinary reads and local service availability must not depend on a
remote SIEM. External effects need durable intent plus result/unknown
records. No fire-and-forget audit path may masquerade as transactional
evidence.

Provide an authorized unified audit center with UTC/local display
controls, time bounds, severity ranges, stream/category,
event/action/outcome, actor/role, resource,
request/trace/workflow/job/package/delivery correlation,
service/release, reason code and provider filters. Support AND/OR groups
and exact/range queries through a bounded query builder, not raw SQL or
arbitrary regex. Provide stable cursor pagination, saved queries,
incident timelines, case annotations, correlation pivots and evidence
exports. Search and export are themselves audited; field-level
authorization prevents customer or overly broad staff access.

Define indexes/partitions, bounded query windows/results, export jobs,
retention, legal holds and reversible redaction projections. If indexing
lags, display freshness and source coverage; search indexes are
rebuildable, not the sole audit authority. Use append-only application
policy, signed hash-chain checkpoints and independent immutable
retention for tamper evidence, while stating that compromised root/key
holders can still affect local evidence. Never overwrite history to make
a dashboard green.

## SIEM and syslog transport

Offer administrator-configurable RFC 5424 events over RFC 5425 TLS,
default port 6514, with octet-count framing and proper server
identity/certificate validation. Prefer mutual TLS where the receiver
supports it. Optionally provide reviewed OTLP/HTTPS and standard
projected JSONL/CEF adapters. Use current TLS 1.2/1.3 policy; do not
inherit obsolete cipher recommendations from historical protocol
documents. Never fall back to plaintext TCP/UDP or disable certificate
checks after a connection failure. TLS protects each hop, not the
original event's end-to-end truth.
[<u>3</u>](https://www.rfc-editor.org/rfc/rfc5425)

Use a persistent privacy-projected outbox/spool, independently scheduled
bounded retry, exponential backoff/jitter, quotas, dead-letter state,
restart recovery, event-ID deduplication, delivery cursor and
receiver/reconciliation receipts where supported. Describe delivery as
**at least once**, not exactly once. A TCP/TLS write is transport
acceptance, not proof of receiver indexing. Display queue depth, oldest
pending age, storage budget, last verified connection, protocol errors,
drops/dead letters and unconfirmed delivery.

Test destination configuration with synthetic events only, validated
private egress exceptions and protected client key handling. Test
receiver outage, bad/wrong/expired certificates, mTLS rejection,
restart, queue saturation, disk full, duplicate delivery, replay,
receiver restoration, framing/multibyte messages and filtering privacy.
No silent event loss; critical audit stays local even when forwarding is
unhealthy.

# 10. Jobs, maintenance, installation, and delivery trust

Use durable bounded jobs with claims, monotonic fencing, attempt/result
records, cancellation boundaries and explicit unknown-outcome
reconciliation. A named lock alone is not proof stale work stopped after
connection loss. Separate web-serving and worker roles for scale, use
shared sessions/storage, and load-test the actual connection/resource
budget before claiming horizontal availability.

Maintenance stops new work and awaits every started
writer/provider/controller child, not merely open HTTP sockets or
scheduler timers. Hold maintenance if drain fails. Database connections
must not close before cooperating work settles. Never force a restart to
make a deployment proceed while asynchronous writes may continue.

Provide a guided fresh native VPS installer, a separately evidenced
Docker path, health/maintenance CLI, plan-default portable migration
CLI, backup/verify/recovery tools, and a controlled uninstall plan. Pin
immutable source commits and reviewed artifacts; no unattended
curl-to-shell/latest-main installation as a security claim. Fresh
install establishes its trusted anti-downgrade floor once before
migrations/first startup and refuses existing/partial installations. Do
not fabricate update receipts.

Updates verify source/build/helper/floor compatibility, exact CI,
current host identity/custody, accepted drain, backup/recovery
readiness, reviewed change scope and bounded publication. Preserve
immutable root helpers and existing settings/data. Record whole release
separately from component repairs. Volatile runtime metadata needs a
reviewed object-role model and actual protected ownership—not blanket
timestamp waivers or repeatedly failing strict checks. A precondition
failure stops before publication and consumes any one-attempt authority.

Uninstall is separately authorized and previews exact application-owned
resources. Require an independently recoverable encrypted export, exact
target confirmation and retention decision before destructive removal.
Do not claim a ZIP equals a safe backup. Preserve shared packages,
external providers and unrelated resources. If complete data cleanup is
not proved, document remaining artifacts rather than claiming full
purge.

# 11. Testing, acceptance, and delivery requirements

Deliver source, lockfiles, migrations/schema contracts, API
specifications, versioned portable schemas/adapters, independent
verifier/extractor/reference importer, backup/recovery runbooks,
deployment profiles, test fixtures, threat models, ADRs,
SBOM/provenance, operator/admin/customer guides, diagrams, application
context and privacy-safe session records.

Required evidence categories are separate: design; source inspection;
unit/contract tests; synthetic integration; exact complete CI/protected
build; installed host; customer workflow; and recovery drill. Record
source SHA, environment, commands, pass/fail/skip, artifacts,
limitations and actual outcomes. Never turn not-run or mocked evidence
into acceptance.

The test plan must include negative authorization across all
roles/resources; MFA/reset/SSO bypass and redirect-loop regressions;
CSRF/proxy/header/host attacks; injection/SSRF/upload/archive attacks;
encryption tamper/key rotation; durable audit failure and query/export
privacy; every portable/crash boundary; independent restore/corruption
drills; worker/drain/provider duplicate and uncertain effects; PWA
logout/update/cache safety; and complete
accessibility/keyboard/screen-reader journeys at representative
mobile/tablet/desktop widths and zoom.

Use dependency/secret/static scans, secure review and authorized dynamic
testing. Resolve reachable Critical/High issues before internet
production release, or hold the affected capability. Document Medium/Low
disposition and owner, retest mitigations, and keep gates intact.
Existing repository Portal plus full Android/iOS CI requirements must
not be silently reduced because native feature launch is Day-2.

For initial go-live, require actual canonical HTTPS, local
onboarding/MFA/password-policy acceptance, role/ownership and file
downloads, healthy restricted controllers, verified encrypted
independent backups and isolated recovery, portable multi-record
roundtrip/hash/ownership acceptance, operational audit/search/forwarding
evidence, and no unresolved launch-enabled Critical/High findings.
Optional integrations can remain visibly disabled; they cannot be called
working until tested.

Work in phases: requirements/threat/contract decisions; secure identity
and data foundation; orders/files/core UX; portable/recovery and keys;
durable logging/incident/forwarding; optional integrations;
lifecycle/deployment; complete release and accessibility acceptance.
Integrate overlapping schema/auth/UI changes once. Ask only for genuine
business/security/production decisions; otherwise use documented secure
defaults and continue reversible preparation.

At each phase return implemented changes, exact tests, unresolved
blockers, residual risk, documentation/context/session links, and Git
commit. If blocked, identify the narrow missing evidence or decision. Do
not bypass a safeguard, reuse stale acceptance, invent a successful
restore, or restart an uncertain operation merely to report completion.

# References

Authoritative standards were fetched on20 November2026. They guide
engineering requirements, not compliance certification.

\[1\] OWASP Application Security Verification Standard 5.0.0 —
[<u>https://asvs.owasp.org/</u>](https://asvs.owasp.org/)

\[2\] OpenTelemetry Logs Data Model —
[<u>https://opentelemetry.io/docs/specs/otel/logs/data-model/</u>](https://opentelemetry.io/docs/specs/otel/logs/data-model/)

\[3\] RFC 5425 TLS Transport Mapping for Syslog —
[<u>https://www.rfc-editor.org/rfc/rfc5425</u>](https://www.rfc-editor.org/rfc/rfc5425)

\[4\] NIST SP 800-63B-4 Authentication and Authenticator Management —
[<u>https://pages.nist.gov/800-63-4/sp800-63b.html</u>](https://pages.nist.gov/800-63-4/sp800-63b.html)

\[5\] W3C Web Content Accessibility Guidelines 2.2 —
[<u>https://www.w3.org/TR/WCAG22/</u>](https://www.w3.org/TR/WCAG22/)

\[6\] OWASP Logging Cheat Sheet —
[<u>https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html</u>](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
