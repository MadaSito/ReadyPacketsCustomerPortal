/**
 * Seeds SYNTHETIC demo data for the hosted preview and local development. Never for production.
 *
 *   pnpm seed:demo                    # first run: accounts + demo data; later runs: "nothing changed"
 *   pnpm seed:demo --fill-missing     # re-run every (idempotent) data step, e.g. after a module landed
 *
 * Everything goes through module SERVICES (never raw inserts into another module's tables), so every
 * mutation produces the same audit records as the portal would. Accounts are provisioned through
 * identity.provisionLocalAccount(..., { reason: "demo_seed" }); the data steps act through short-lived,
 * audited, HTTP-unusable ops sessions (identity.sessions.openOpsSession) that are revoked at the end.
 *
 * Passwords are never accepted on the command line. By default a fresh password is generated per account
 * and printed ONCE in a clearly marked DEMO-ONLY block. Set RP_DEMO_PASSWORD_FILE to a 0600 file you own to
 * use one known password for all demo accounts instead (it is then not printed). MFA is not pre-enrolled:
 * the first sign-in of each demo account enrols an authenticator app, as for any account.
 *
 * Exit codes: 0 seeded / already seeded · 1 failed (or some steps failed) · 64 usage ·
 *             77 refused (production profile) · 78 configuration.
 */
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import type { AppConfig } from "../../server/config/env.js";
import type { Services } from "../../server/container.js";
import { DomainError } from "../../server/core/errors.js";
import type { SessionPrincipal } from "../../server/core/types.js";
import { seedOrdersDemo } from "../../server/modules/orders/demoSeed.js";
import { toImportInput } from "./catalog/importInput.js";
import { loadOfferings, OfferingsFileError } from "./catalog/offerings.js";
import { readSecretFile } from "./lib/secretFile.js";

/* ------------------------------------------------------------------ fixtures */

export type DemoAccountKey = "admin" | "staff" | "customerA" | "customerB";

export const DEMO_ACCOUNTS: readonly { key: DemoAccountKey; email: string; name: string; role: "admin" | "staff" | "customer" }[] = [
  { key: "admin", email: "demo.admin@example.com", name: "Demo Admin (synthetic)", role: "admin" },
  { key: "staff", email: "demo.staff@example.com", name: "Demo Staff (synthetic)", role: "staff" },
  { key: "customerA", email: "demo.customer.a@example.com", name: "Avery Example (synthetic customer)", role: "customer" },
  { key: "customerB", email: "demo.customer.b@example.com", name: "Blake Example (synthetic customer)", role: "customer" },
];

/**
 * Target workflow path per demo order; the seeder walks the service-offered transitions towards it.
 * `productKeys` name packet products of the offerings file; `fallbackIndex` picks a synthetic demo product when
 * the offerings file is not available. The selections cover the documented production-webhook patterns:
 * one packet (packet N / its tier), several packets (packet 7 / Mixed) and all six packets (bundle discount).
 */
const DEMO_ORDERS: readonly { key: string; owner: "customerA" | "customerB"; projectName: string; path: readonly string[]; productKeys: readonly string[]; fallbackIndex: number }[] = [
  { key: "a1", owner: "customerA", projectName: "Demo: Smart Valve Invention (synthetic)", path: ["submitted"], productKeys: ["packet-1-premium"], fallbackIndex: 0 },
  { key: "a2", owner: "customerA", projectName: "Demo: Harbor Street Studio Launch (synthetic)", path: ["submitted", "in_review"], productKeys: ["packet-1-premium", "packet-2-basic"], fallbackIndex: 1 },
  { key: "a3", owner: "customerA", projectName: "Demo: Maple Court Funding Plan (synthetic)", path: ["submitted", "in_review", "awaiting_customer"], productKeys: ["packet-3-standard"], fallbackIndex: 0 },
  { key: "a4", owner: "customerA", projectName: "Demo: Oak Lane Full Build (synthetic)", path: ["submitted", "in_review", "in_progress", "delivered", "completed"], productKeys: ["packet-1-basic", "packet-2-basic", "packet-3-basic", "packet-4-basic", "packet-5-basic", "packet-6-basic"], fallbackIndex: 2 },
  { key: "b1", owner: "customerB", projectName: "Demo: Summit Plaza Operations (synthetic)", path: ["submitted", "in_review", "in_progress"], productKeys: ["packet-4-standard", "packet-6-basic"], fallbackIndex: 1 },
];

const DEMO_TICKET_SUBJECT = "Demo: question about my synthetic packet";
const POLICY_SLUG = "demo-terms-of-service";
const INTAKE_SLUG = "demo-project-intake";
const SEED_KEY = (suffix: string) => `demo_seed_${suffix}_v1`;

/* ------------------------------------------------------------------ result */

export interface DemoSeedResult {
  status: "seeded" | "already_seeded";
  /** Human-readable list of what changed in this run. */
  changed: string[];
  /** "<module>: <why>" — e.g. "files: not available". */
  skipped: string[];
  /** "<step>: <reason code>" — non-empty makes the CLI exit 1. */
  failed: string[];
  /** Only for accounts created in THIS run with a generated password (never logged, printed once by the CLI). */
  credentials: { email: string; role: string; password: string }[];
}

export interface DemoSeedOptions {
  /** Same password for every NEW demo account (from RP_DEMO_PASSWORD_FILE); otherwise generated per account. */
  password?: string;
  /** Re-run every data step even when all demo accounts already exist. */
  fillMissing?: boolean;
}

/* ------------------------------------------------------------------ synthetic sample file */

/** A minimal, passive (no actions/scripts/embedded files) one-page PDF-1.4 with a correct xref table. */
export function syntheticPdf(title: string): Buffer {
  const text = title.replace(/[\\()]/g, "");
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj 0 -28 Td /F1 11 Tf (Synthetic demo document - not a real record.) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/* ------------------------------------------------------------------ seeder */

function reasonOf(error: unknown): string {
  return error instanceof DomainError ? error.reasonCode : "UNEXPECTED";
}

export async function runDemoSeed(services: Services, config: AppConfig, options: DemoSeedOptions = {}): Promise<DemoSeedResult> {
  if (config.deploymentProfile === "production") {
    throw new DomainError("FORBIDDEN", "DEMO_SEED_FORBIDDEN", "Demo data cannot be seeded in production.");
  }
  const log = services.logger;
  const result: DemoSeedResult = { status: "seeded", changed: [], skipped: [], failed: [], credentials: [] };

  /* ---- 1. accounts (one transaction: all missing accounts or none) ---- */
  const users = new Map<DemoAccountKey, { userId: number; publicId: string }>();
  const missing: typeof DEMO_ACCOUNTS[number][] = [];
  for (const account of DEMO_ACCOUNTS) {
    const found = await services.identity.findUserIdByEmail(account.email);
    if (found) users.set(account.key, { userId: found.userId, publicId: found.publicId });
    else missing.push(account);
  }
  if (missing.length === 0 && !options.fillMissing && !(await services.orders.catalog.isEmpty())) {
    log.info("demo seed: already seeded, nothing changed", { event: "ops.demo_seed.noop" });
    return { ...result, status: "already_seeded" };
  }
  if (missing.length > 0) {
    const planned = missing.map((account) => ({ account, password: options.password ?? services.identity.generateTemporaryPassword() }));
    const created = await services.db.transaction(async (tx) => {
      const out: { key: DemoAccountKey; userId: number; publicId: string }[] = [];
      for (const { account, password } of planned) {
        const row = await services.identity.provisionLocalAccount(
          { email: account.email, name: account.name, role: account.role, password, mustChangePassword: false },
          { tx, reason: "demo_seed" },
        );
        out.push({ key: account.key, userId: row.userId, publicId: row.publicId });
      }
      return out;
    });
    for (const row of created) users.set(row.key, { userId: row.userId, publicId: row.publicId });
    for (const { account, password } of planned) {
      result.changed.push(`account ${account.email} (${account.role})`);
      if (!options.password) result.credentials.push({ email: account.email, role: account.role, password });
    }
    log.info("demo seed: accounts provisioned", { event: "ops.demo_seed.accounts", count: created.length });
  }

  /* ---- 2. ops sessions ---- */
  const principals = new Map<DemoAccountKey, SessionPrincipal>();
  const opened: SessionPrincipal[] = [];
  const as = async (key: DemoAccountKey): Promise<SessionPrincipal> => {
    const existing = principals.get(key);
    if (existing) return existing;
    const user = users.get(key);
    if (!user) throw new DomainError("NOT_FOUND", "DEMO_ACCOUNT_MISSING", "A demo account is missing.");
    const principal = await services.identity.sessions.openOpsSession(user.userId, { reason: "demo_seed" });
    principals.set(key, principal);
    opened.push(principal);
    return principal;
  };

  const step = async (label: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      const reason = reasonOf(error);
      result.failed.push(`${label}: ${reason}`);
      log.warn("demo seed step failed", { event: "ops.demo_seed.step_failed", step: label, reasonCode: reason, errorName: error instanceof Error ? error.name : "unknown" });
    }
  };
  const skip = (module: string, why = "not available") => {
    result.skipped.push(`${module}: ${why}`);
    log.info(`skipped: ${module} ${why}`, { event: "ops.demo_seed.skipped", module, why });
  };

  try {
    /* ---- 3. catalog ---- */
    // Preferred: the owner's offerings file, loaded through the same audited upsert as `ops:catalog-import`.
    // The catalog is product data, not personal data; customers, orders and messages stay synthetic.
    // Fallback (file missing or invalid): the clearly synthetic demo products.
    const products: string[] = [];
    const productsByKey = new Map<string, string>();
    await step("orders.catalog", async () => {
      let imported = false;
      try {
        const offerings = await loadOfferings();
        const outcome = await services.orders.catalog.upsertFromOfferings(await as("admin"), toImportInput(offerings), { dryRun: false });
        imported = true;
        const touched = outcome.groups.created + outcome.groups.updated + outcome.products.created + outcome.products.versioned;
        if (touched > 0 || outcome.bundleRule === "created" || outcome.bundleRule === "updated")
          result.changed.push(`catalog (offerings matrix ${offerings.matrixVersion}: ${outcome.products.created} products added, ${outcome.products.versioned} re-versioned)`);
      } catch (error) {
        const missingFile = error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
        if (!(error instanceof OfferingsFileError) && !missingFile) throw error;
        log.warn("demo seed: offerings file unavailable, using synthetic demo products", { event: "ops.demo_seed.offerings_unavailable" });
      }
      if (!imported) {
        const seeded = await seedOrdersDemo(services.orders, await as("admin"));
        if (seeded.seeded) result.changed.push(`catalog (${seeded.productPublicIds.length} demo products)`);
      }
      for (const group of await services.orders.catalog.listActive())
        for (const product of group.products.filter((p) => p.active)) {
          products.push(product.publicId);
          productsByKey.set(product.productKey, product.publicId);
        }
    });

    /* ---- 4. policy (published, required) + acceptance by each customer ---- */
    await step("compliance.policies", async () => {
      const admin = await as("admin");
      const docs = await services.compliance.policies.admin.listDocuments(admin);
      if (!docs.some((doc) => doc.slug === POLICY_SLUG)) {
        const draft = await services.compliance.policies.admin.createDocument(admin, {
          slug: POLICY_SLUG,
          title: "Demo Terms of Service (synthetic)",
          audience: "customer",
          requiresAcceptance: true,
          requiresTypedSignature: false,
          versionLabel: "Demo v1",
          contentFormat: "plain_text",
          bodyText: "These are SYNTHETIC demo terms for a preview installation. They are not a real agreement and must be replaced before going live.",
          changeSummary: "Synthetic demo policy",
        });
        await services.compliance.policies.admin.publishVersion(admin, { versionPublicId: draft.draftVersionPublicId });
        result.changed.push("policy (published demo terms)");
      }
      for (const key of ["customerA", "customerB"] as const) {
        const user = users.get(key)!;
        const pending = await services.compliance.requiredAcceptancesFor(user.userId, { audience: "customer" });
        // Only the demo policy is accepted on the customer's behalf; any other required policy stays pending.
        for (const item of pending.filter((p) => p.slug === POLICY_SLUG)) {
          await services.compliance.policies.accept(await as(key), { versionPublicId: item.versionPublicId, contentHash: item.contentHash, method: "portal_checkbox" });
          result.changed.push(`policy acceptance (${key})`);
        }
      }
    });

    /* ---- 5. orders + workflow states + notes ---- */
    const orderIds = new Map<string, string>();
    if (products.length === 0) {
      skip("orders", "no active catalog products");
    } else {
      const demoItems = (spec: (typeof DEMO_ORDERS)[number]) => {
        const packetIds = spec.productKeys.map((key) => productsByKey.get(key));
        if (packetIds.every((id): id is string => id !== undefined)) return packetIds.map((productPublicId) => ({ productPublicId, quantity: 1 }));
        return [{ productPublicId: products[spec.fallbackIndex % products.length]!, quantity: 1 }];
      };
      for (const spec of DEMO_ORDERS) {
        await step(`orders.${spec.key}`, async () => {
          const customer = await as(spec.owner);
          const created = await services.orders.orders.create(customer, {
            projectName: spec.projectName,
            items: demoItems(spec),
            note: "Synthetic demo order created by the demo seeder.",
            idempotencyKey: SEED_KEY(`order_${spec.key}`),
          });
          orderIds.set(spec.key, created.publicId);
          if (created.created) result.changed.push(`order ${created.reference} (${spec.key})`);
          const staff = await as("staff");
          for (let guard = 0; guard < spec.path.length; guard += 1) {
            const view = await services.orders.orders.get(staff, created.publicId, "console");
            const at = spec.path.indexOf(view.statusKey);
            if (at < 0 || at === spec.path.length - 1) break; // reached target (or moved elsewhere by a human: leave it)
            const next = spec.path[at + 1]!;
            const offered = view.transitions.find((t) => t.to === next);
            if (!offered) throw new DomainError("CONFLICT", "DEMO_TRANSITION_UNAVAILABLE", "The demo workflow path is not offered.");
            await services.orders.orders.transition(staff, {
              orderId: created.publicId,
              expectedVersion: view.version,
              toStatus: next,
              ...(offered.requiresNote || next === "awaiting_customer" ? { note: "Demo: please review the synthetic checklist.", noteVisibility: "customer" as const } : {}),
            });
            result.changed.push(`order ${spec.key} → ${next}`);
          }
          if (created.created && spec.key === "a2") {
            await services.orders.orders.addNote(staff, { orderId: created.publicId, body: "Demo internal note: synthetic data, no action needed.", visibility: "internal" });
            await services.orders.orders.addNote(staff, { orderId: created.publicId, body: "Demo note: we have started reviewing your synthetic packet.", visibility: "customer" });
            result.changed.push("order notes (a2)");
          }
        });
      }
    }
    const a2 = orderIds.get("a2");

    /* ---- 6. one synthetic PDF on order a2 ---- */
    if (!a2) skip("files", "no demo order to attach to");
    else
      await step("files", async () => {
        const staff = await as("staff");
        const listed = await services.files.list(staff, a2, { limit: 10 });
        if (listed.items.length > 0) return;
        const plan = await services.files.beginUpload(staff, a2, { category: "supporting", visibility: "customer_visible" });
        const staged = await services.files.stageUpload("demo-checklist-synthetic.pdf", Readable.from([syntheticPdf("Demo checklist (synthetic)")]), plan.rules);
        try {
          await services.files.commitUpload(staff, plan, staged);
        } finally {
          await services.files.cleanUpload(staged);
        }
        result.changed.push("file (synthetic PDF on a2)");
      });

    /* ---- 7. engagement: message thread + support ticket ---- */
    if (!a2) skip("engagement.messages", "no demo order");
    else
      await step("engagement.messages", async () => {
        const thread = await services.engagement.messages.listByOrder(await as("customerA"), { orderId: a2, limit: 5 });
        if (thread.items.length > 0) return;
        await services.engagement.messages.send(await as("customerA"), { orderId: a2, body: "Hello, this is a synthetic demo message. Is anything else needed?", idempotencyKey: SEED_KEY("msg_a2_1") });
        await services.engagement.messages.send(await as("staff"), { orderId: a2, body: "Thanks. This is a synthetic reply from the demo staff account.", idempotencyKey: SEED_KEY("msg_a2_2") });
        result.changed.push("message thread (a2)");
      });
    await step("engagement.tickets", async () => {
      const mine = await services.engagement.tickets.list(await as("customerA"), { limit: 50 });
      if (mine.items.some((item) => item.subject === DEMO_TICKET_SUBJECT)) return;
      const ticket = await services.engagement.tickets.create(await as("customerA"), {
        subject: DEMO_TICKET_SUBJECT,
        category: "general",
        body: "This is a synthetic demo support ticket created by the demo seeder.",
        relatedOrderId: a2 ?? null,
        idempotencyKey: SEED_KEY("ticket_1"),
      });
      await services.engagement.tickets.adminReply(await as("staff"), {
        ticketId: ticket.ticket.publicId,
        body: "Synthetic demo reply: we are looking into it.",
        nextStatus: "pending_customer",
        idempotencyKey: SEED_KEY("ticket_1_reply"),
      });
      result.changed.push("support ticket (with staff reply)");
    });

    /* ---- 8. compliance: intake questionnaire + submission, invoices ---- */
    await step("compliance.intake", async () => {
      const admin = await as("admin");
      const list = await services.compliance.intake.admin.listQuestionnaires(admin);
      if (!list.some((q) => q.slug === INTAKE_SLUG)) {
        const draft = await services.compliance.intake.admin.createQuestionnaire(admin, {
          slug: INTAKE_SLUG,
          title: "Demo Project Intake (synthetic)",
          description: "Synthetic demo questionnaire.",
          scopeKind: "default",
          scopeRef: null,
          fields: [
            { key: "site_name", label: "Site name", type: "short_text", required: true, sensitive: false, maxLength: 120 },
            { key: "notes", label: "Anything else we should know?", type: "long_text", required: false, sensitive: false, maxLength: 2000 },
          ],
        });
        await services.compliance.intake.admin.publishVersion(admin, draft.draftVersionPublicId);
        result.changed.push("intake questionnaire (published)");
      }
      if (!a2) return;
      const customer = await as("customerA");
      const forOrder = await services.compliance.intake.listForOrder(customer, a2);
      const item = forOrder.items.find((i) => i.slug === INTAKE_SLUG);
      if (item && !item.submission) {
        await services.compliance.intake.submit(customer, {
          orderPublicId: a2,
          questionnairePublicId: item.questionnairePublicId,
          answers: { site_name: "Harbor Street Demo Site (synthetic)", notes: "Synthetic answers." },
        });
        result.changed.push("intake submission (a2)");
      }
    });

    for (const [orderKey, paid] of [["a4", true], ["a2", false]] as const) {
      const orderPublicId = orderIds.get(orderKey);
      if (!orderPublicId) {
        skip(`compliance.invoices (${orderKey})`, "no demo order");
        continue;
      }
      await step(`compliance.invoices.${orderKey}`, async () => {
        const admin = await as("admin");
        const existing = await services.compliance.invoices.listForOrder(admin, orderPublicId);
        if (existing.items.length > 0) return;
        const draft = await services.compliance.invoices.admin.createDraft(admin, {
          orderPublicId,
          currency: "USD",
          lines: [{ description: "Demo packet preparation (synthetic)", quantity: 1, unitAmountMinor: paid ? 125_00 : 89_00 }],
          discountMinor: 0,
          taxMinor: 0,
          memo: "Synthetic demo invoice.",
        });
        await services.compliance.invoices.admin.issue(admin, { invoicePublicId: draft.invoicePublicId });
        result.changed.push(`invoice (${orderKey}, issued)`);
        if (paid) {
          await services.compliance.invoices.admin.recordManualPayment(await as("staff"), {
            invoicePublicId: draft.invoicePublicId,
            method: "check",
            amountMinor: draft.totalMinor,
            currency: draft.currency,
            reference: "DEMO-CHECK-0001",
            notes: "Synthetic demo payment.",
            idempotencyKey: SEED_KEY(`payment_${orderKey}`),
          });
          result.changed.push(`invoice payment (${orderKey}, manual)`);
        }
      });
    }
  } finally {
    for (const principal of opened) {
      await services.identity.sessions.revoke(principal.sessionId, "demo_seed_complete").catch(() => {
        result.failed.push("identity.sessions.revoke: UNEXPECTED");
      });
    }
  }

  if (result.changed.length === 0 && result.failed.length === 0) result.status = "already_seeded";
  log.info("demo seed completed", { event: "ops.demo_seed.completed", changed: result.changed.length, skipped: result.skipped.length, failed: result.failed.length });
  return result;
}

/* ------------------------------------------------------------------ CLI */

export function renderResult(result: DemoSeedResult): string[] {
  const lines: string[] = [];
  if (result.status === "already_seeded") {
    lines.push("Demo data already seeded; nothing changed.");
  } else {
    lines.push(`Demo data seeded (${result.changed.length} changes):`);
    for (const item of result.changed) lines.push(`  + ${item}`);
  }
  if (result.credentials.length > 0) {
    lines.push(
      "",
      "==================== DEMO-ONLY CREDENTIALS (synthetic accounts) ====================",
      "Shown once; not stored or logged anywhere. Never reuse these on a real installation.",
      "First sign-in of each account enrols an authenticator app (TOTP).",
    );
    for (const c of result.credentials) lines.push(`  ${c.role.padEnd(8)} ${c.email.padEnd(32)} ${c.password}`);
    lines.push("=====================================================================================");
  }
  if (result.skipped.length > 0) {
    lines.push("", "Skipped:");
    for (const item of result.skipped) lines.push(`  - skipped: ${item}`);
  }
  if (result.failed.length > 0) {
    lines.push("", "Failed steps (see the service log for the correlated records):");
    for (const item of result.failed) lines.push(`  ! ${item}`);
  }
  return lines;
}

async function main(): Promise<number> {
  if (process.argv.some((value) => /^--password/.test(value))) {
    console.error("Passwords are not accepted on the command line. Use RP_DEMO_PASSWORD_FILE (a 0600 file you own).");
    return 64;
  }
  const unknown = process.argv.slice(2).filter((value) => value !== "--fill-missing");
  if (unknown.length > 0) {
    console.error("Usage: pnpm seed:demo [--fill-missing]");
    return 64;
  }
  const { ConfigError, loadConfig } = await import("../../server/config/env.js");
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : "Configuration could not be loaded.");
    return 78;
  }
  if (config.deploymentProfile === "production") {
    console.error("Refused: demo data is never seeded on a production installation.");
    return 77;
  }
  let password: string | undefined;
  const file = process.env.RP_DEMO_PASSWORD_FILE;
  if (file) {
    try {
      password = readSecretFile(file);
    } catch {
      console.error("The password file could not be used. It must be a regular file owned by you, with mode 0600, no larger than 1 KiB.");
      return 78;
    }
  }
  const { createContainer } = await import("../../server/container.js");
  const container = createContainer(config);
  try {
    await container.services.platform.assertSchemaContract();
    const result = await runDemoSeed(container.services, config, { password, fillMissing: process.argv.includes("--fill-missing") });
    for (const line of renderResult(result)) console.log(line);
    return result.failed.length > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof DomainError) {
      console.error(`Not seeded: ${error.safeMessage}`);
      return error.reasonCode === "DEMO_SEED_FORBIDDEN" ? 77 : 1;
    }
    console.error("Demo data could not be seeded (unexpected error; see the service log for the correlated record).");
    return 1;
  } finally {
    await container.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    () => {
      console.error("Demo data could not be seeded.");
      process.exit(1);
    },
  );
}
