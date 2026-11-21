import type { UserRole } from "./domain.js";

/**
 * Capability catalogue. A capability answers "may this ROLE attempt this KIND of action";
 * resource scope (ownership, grants, locks) is always checked separately in the module policy.
 * Module owners append their capabilities in their own block via minimal edits.
 */
export const CAPABILITIES = [
  // identity / assurance
  "customers.read_all",
  "customers.manage",
  "customers.credentials.administer",
  "sessions.revoke_any",
  "staff.manage",
  "customers.reference.change",
  // orders / catalog
  "orders.create",
  "orders.read_all",
  "orders.manage",
  "orders.transition",
  "orders.reassign",
  "orders.identifiers.change",
  "orders.production.trigger",
  "catalog.manage",
  "workflows.manage",
  // files
  "files.read_all",
  "files.manage",
  "files.visibility.change",
  // engagement
  "messages.read_all",
  "tickets.read_all",
  "tickets.manage",
  "search.global",
  // compliance
  "policies.manage",
  "intake.manage",
  "intake.review",
  "invoices.read_all",
  "invoices.record_payment",
  "invoices.manage",
  // audit / siem
  "audit.read",
  "audit.export",
  "audit.cases.manage",
  "audit.retention.manage",
  "siem.read",
  "siem.manage",
  // platform / integrations / jobs
  "platform.settings.manage",
  "platform.setup.run",
  "platform.health.read",
  "integrations.manage",
  "jobs.read",
  "jobs.manage",
  "jobs.mail.capture",
  "maintenance.manage",
  // increment 03: mail delivery and templates, automations, storage connections, single sign-on
  "mail.manage",
  "mail.content.read",
  "automations.read",
  "automations.manage",
  "storage.manage",
  "identity.sso.manage",
  // increment 04: protection, sessions, knowledge, community, referrals, API and webhooks, privacy, payments
  "security.firewall.read",
  "security.firewall.manage",
  "sessions.read_all",
  "sessions.policy.manage",
  "orders.phase.unlock",
  "orders.access.grant",
  "knowledge.manage",
  "community.moderate",
  "community.manage",
  "referrals.read_all",
  "referrals.manage",
  "api.keys.manage",
  "api.logs.read",
  "api.replay",
  "webhooks.manage",
  "privacy.consent.read",
  "privacy.consent.manage",
  "payments.manage",
  "carts.read_all",
  "storage.copies.read",
  // portable / backup
  "portable.export",
  "portable.import",
  "backup.read",
  "backup.run",
  "backup.verify",
  "backup.restore",
  "backup.retention.manage",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const STAFF_CAPABILITIES: readonly Capability[] = [
  "customers.read_all",
  "orders.create",
  "orders.read_all",
  "orders.manage",
  "orders.transition",
  "orders.production.trigger",
  "files.read_all",
  "files.manage",
  "files.visibility.change",
  "messages.read_all",
  "tickets.read_all",
  "tickets.manage",
  "search.global",
  "intake.review",
  "invoices.read_all",
  "invoices.record_payment",
  "invoices.manage",
  "platform.health.read",
  "orders.phase.unlock",
  "knowledge.manage",
  "community.moderate",
  "referrals.read_all",
  "carts.read_all",
];

/** Default role grants. Staff least-privilege by assignment is a recorded ADR target, not yet implemented. */
export const ROLE_CAPABILITIES: Record<UserRole, ReadonlySet<Capability>> = {
  admin: new Set<Capability>(CAPABILITIES),
  staff: new Set<Capability>(STAFF_CAPABILITIES),
  customer: new Set<Capability>(["orders.create"]),
};

/**
 * Capabilities that additionally require a FRESH step-up (re-authentication with MFA) regardless of role.
 * Enforced server-side by `requireCapability` in server/trpc/trpc.ts.
 */
export const STEP_UP_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "customers.credentials.administer",
  "sessions.revoke_any",
  "staff.manage",
  "customers.reference.change",
  "orders.reassign",
  "orders.identifiers.change",
  "policies.manage",
  "invoices.manage",
  "invoices.record_payment",
  "audit.export",
  "audit.retention.manage",
  "siem.manage",
  "platform.settings.manage",
  "platform.setup.run",
  "integrations.manage",
  "jobs.mail.capture",
  "maintenance.manage",
  "mail.manage",
  "mail.content.read",
  "automations.manage",
  "storage.manage",
  "identity.sso.manage",
  "security.firewall.manage",
  "sessions.policy.manage",
  "orders.access.grant",
  "community.manage",
  "referrals.manage",
  "api.keys.manage",
  "api.replay",
  "webhooks.manage",
  "privacy.consent.manage",
  "payments.manage",
  "portable.export",
  "portable.import",
  "backup.run",
  "backup.restore",
  "backup.retention.manage",
]);

export function roleHasCapability(role: UserRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].has(capability);
}
