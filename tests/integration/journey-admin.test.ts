/**
 * Journey (b): bootstrap administrator → forced password change + MFA → step-up → invite a customer →
 * customer activates and orders → administrator sees it; least-privilege staff and customer denial across
 * every guarded procedure in the assembled appRouter.
 */
import type { AnyTRPCProcedure } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "../../server/trpc/root.js";
import { adminProcedure, protectedProcedure, staffProcedure } from "../../server/trpc/trpc.js";
import {
  Browser, createSystem, enrolTotp, linkToken, NEW_PASSWORD, seedProduct, stepUp, STRONG_PASSWORD,
  type ReadyAdmin, type System,
} from "./harness.js";

const ADMIN_EMAIL = "ada.admin@example.test";
const CUSTOMER_EMAIL = "invited.customer@example.test";
const STAFF_EMAIL = "sam.staff@example.test";
let sys: System;
let admin: ReadyAdmin;
let customer: Browser;
let staff: Browser;
let customerId: string;
let orderId: string;
const requestIds: Record<string, string> = {};

beforeAll(async () => { sys = await createSystem(); });
afterAll(async () => sys?.close());

async function events(requestId: string): Promise<string[]> {
  return (await sys.audit({ requestId })).map((event) => event.eventName);
}

describe("administrator journey (assembled system)", () => {
  it("bootstraps exactly one administrator through identity.provisionLocalAccount", async () => {
    const { identity } = sys.container.services;
    const created = await sys.t.db.transaction((tx) => identity.provisionLocalAccount(
      { email: ADMIN_EMAIL, name: "Ada Admin", role: "admin", password: STRONG_PASSWORD, mustChangePassword: true },
      { tx, reason: "bootstrap_admin" },
    ));
    expect(created.publicId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await sys.audit({ eventName: "identity.account.provisioned" })).toHaveLength(1);
    await expect(sys.t.db.transaction((tx) => identity.provisionLocalAccount(
      { email: "second.admin@example.test", name: "Second Admin", role: "admin", password: STRONG_PASSWORD, mustChangePassword: true },
      { tx, reason: "bootstrap_admin" },
    ))).rejects.toMatchObject({ reasonCode: "ADMIN_EXISTS" });
    admin = { browser: sys.browser(), publicId: created.publicId, email: ADMIN_EMAIL, password: STRONG_PASSWORD, secret: "" };
  });

  it("signs in to remediation, enrols TOTP, then must change the bootstrap password before any console access", async () => {
    const signIn = await admin.browser.mutate<{ nextStep: string }>("identity.signIn", { email: ADMIN_EMAIL, password: STRONG_PASSWORD });
    expect(Browser.ok(signIn).nextStep).toBe("enroll_mfa");
    expect(await events(signIn.requestId)).toContain("auth.login.succeeded");
    const denied = await admin.browser.query("identity.admin.customers.list", {});
    expect(denied.error?.safe.domainCode).toBe("REMEDIATION_REQUIRED");

    admin.secret = (await enrolTotp(sys, admin.browser)).secret;
    expect(Browser.ok(await admin.browser.query<{ nextStep: string }>("identity.me")).nextStep).toBe("change_password");
    const changed = await admin.browser.mutate<{ nextStep: string | null }>("identity.changePassword", {
      currentPassword: STRONG_PASSWORD, newPassword: NEW_PASSWORD,
    });
    expect(Browser.ok(changed).nextStep).toBeNull();
    expect(await events(changed.requestId)).toContain("auth.password.changed");
    admin.password = NEW_PASSWORD;
    expect(Browser.ok(await admin.browser.query<{ state: string }>("identity.me")).state).toBe("full");
  });

  it("requires a fresh step-up for staff management, and accepts one built from password + TOTP", async () => {
    const withoutStepUp = await admin.browser.mutate("identity.admin.staff.create", { email: STAFF_EMAIL, name: "Sam Staff", role: "staff" });
    expect(withoutStepUp.error?.safe.reasonCode).toBe("STEP_UP_REQUIRED");
    const stepped = await stepUp(sys, admin.browser, admin.password, admin.secret);
    Browser.ok(stepped);
    expect(await events(stepped.requestId)).toContain("auth.step_up.verified");
    requestIds.stepUp = stepped.requestId;
  });

  it("invites a customer; the activation link arrives by mail, never in the response", async () => {
    const created = await admin.browser.mutate<{ customerId: string; previewLink?: string }>("identity.admin.customers.create", {
      email: CUSTOMER_EMAIL, name: "Ivy Invited",
    });
    const body = Browser.ok(created);
    expect(body.previewLink).toBeUndefined();
    customerId = body.customerId;
    expect(await events(created.requestId)).toContain("admin.customer.created");
    requestIds.customerCreated = created.requestId;

    const [mail] = await sys.inbox(CUSTOMER_EMAIL);
    expect(mail?.text).toMatch(/Activate it and choose your password/);
    customer = sys.browser();
    const activated = await customer.mutate("identity.activateAccount", { token: linkToken(mail!.text), password: STRONG_PASSWORD });
    expect(Browser.ok(activated)).toEqual({ activated: true });
    expect(await events(activated.requestId)).toContain("auth.account.activated");

    Browser.ok(await customer.mutate("identity.signIn", { email: CUSTOMER_EMAIL, password: STRONG_PASSWORD }));
    await enrolTotp(sys, customer);
    expect(Browser.ok(await customer.query<{ state: string }>("identity.me")).state).toBe("full");
  });

  it("the administrator sees the customer's order in the console", async () => {
    const productId = await seedProduct(admin);
    const order = Browser.ok(await customer.mutate<{ publicId: string }>("orders.create", {
      projectName: "Invited project", items: [{ productPublicId: productId, quantity: 1 }], idempotencyKey: "journey-admin-order-0001",
    }));
    orderId = order.publicId;
    const list = Browser.ok(await admin.browser.query<{ items: { publicId: string }[] }>("orders.admin.list", { customerPublicId: customerId }));
    expect(list.items.map((item) => item.publicId)).toEqual([orderId]);
    const detail = Browser.ok(await admin.browser.query("orders.admin.get", { orderId }));
    expect(JSON.stringify(detail)).toContain("Invited project");
  });

  it("staff (invited after step-up) can read orders but every admin-only capability is refused", async () => {
    const created = await admin.browser.mutate<{ userId: string; previewLink?: string }>("identity.admin.staff.create", {
      email: STAFF_EMAIL, name: "Sam Staff", role: "staff",
    });
    expect(Browser.ok(created).previewLink).toBeUndefined();
    const [mail] = await sys.inbox(STAFF_EMAIL);
    staff = sys.browser();
    Browser.ok(await staff.mutate("identity.activateAccount", { token: linkToken(mail!.text), password: STRONG_PASSWORD }));
    Browser.ok(await staff.mutate("identity.signIn", { email: STAFF_EMAIL, password: STRONG_PASSWORD }));
    await enrolTotp(sys, staff);

    expect(Browser.ok(await staff.query<{ items: unknown[] }>("orders.admin.list", {})).items).toHaveLength(1);
    for (const [path, input, kind] of [
      ["identity.admin.staff.list", {}, "query"],
      ["identity.admin.customers.create", { email: "nobody@example.test", name: "Nobody" }, "mutation"],
      ["audit.search", { query: { from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" } }, "query"],
      ["orders.admin.catalog.createGroup", { name: "Nope", description: "", sortOrder: 0, active: true }, "mutation"],
    ] as const) {
      const result = kind === "query" ? await staff.query(path, input) : await staff.mutate(path, input);
      expect(result.error?.safe.domainCode, path).toMatch(/^(FORBIDDEN|NOT_FOUND)$/);
    }
  });

  it("the audit center returns the journey's events with structured filters", async () => {
    const window = { from: "2026-11-19T00:00:00Z", to: "2026-11-21T00:00:00Z" };
    const byName = Browser.ok(await admin.browser.query<{ items: unknown[] }>("audit.search", {
      query: { ...window, where: { kind: "group", op: "and", terms: [
        { field: "event_name", op: "in", value: ["admin.customer.created", "auth.step_up.verified"] },
        { field: "actor_role", op: "eq", value: "admin" },
      ] } },
    }));
    const text = JSON.stringify(byName.items);
    expect(byName.items).toHaveLength(2);
    expect(text).toContain("admin.customer.created");
    expect(text).toContain("auth.step_up.verified");

    const byRequest = Browser.ok(await admin.browser.query<{ items: unknown[] }>("audit.search", {
      query: { ...window, where: { kind: "group", op: "and", terms: [{ field: "request_id", op: "eq", value: requestIds.customerCreated! }] } },
    }));
    expect(JSON.stringify(byRequest.items)).toContain("admin.customer.created");
    expect(JSON.stringify(byRequest.items)).not.toContain("auth.step_up.verified");

    const prefix = Browser.ok(await admin.browser.query<{ items: unknown[] }>("audit.search", {
      query: { ...window, where: { kind: "group", op: "and", terms: [
        { field: "event_name", op: "prefix", value: "auth.totp." }, { field: "outcome", op: "eq", value: "completed" },
      ] } },
    }));
    expect(prefix.items.length).toBeGreaterThanOrEqual(3); // admin, customer and staff enrolments
    expect(JSON.stringify(prefix.items)).not.toMatch(/admin\.customer\.created/);
    expect(await sys.audit({ eventName: "audit.search.executed" })).not.toHaveLength(0);
  });

  it("no staff/admin-guarded procedure accepts a full customer session or an anonymous caller", async () => {
    const procedures = appRouter._def.procedures as unknown as Record<string, AnyTRPCProcedure>;
    type Def = { middlewares: unknown[]; type: "query" | "mutation" | "subscription" };
    const middlewares = (procedure: { _def: unknown }) => (procedure._def as unknown as Def).middlewares;
    const base = new Set(middlewares(protectedProcedure as never));
    const guards = [...middlewares(staffProcedure as never), ...middlewares(adminProcedure as never)].filter((m) => !base.has(m));
    const guarded = Object.entries(procedures).filter(([path, procedure]) => {
      const own = (procedure._def as unknown as Def).middlewares;
      return path.includes(".admin.") || guards.some((guard) => own.includes(guard));
    });
    expect(guarded.length).toBeGreaterThan(40);
    const anonymous = sys.browser();
    const failures: string[] = [];
    for (const [path, procedure] of guarded) {
      const type = (procedure._def as unknown as Def).type;
      for (const [who, caller, allowed] of [
        ["customer", customer, ["FORBIDDEN", "NOT_FOUND"]],
        ["anonymous", anonymous, ["UNAUTHENTICATED"]],
      ] as const) {
        const result = type === "query" ? await caller.query(path, {}) : await caller.mutate(path, {});
        const code = result.error?.safe.domainCode;
        if (result.status === 200 || !code || !(allowed as readonly string[]).includes(code)) failures.push(`${who} ${path}: ${result.status} ${code}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it.todo("audit events reach a configured SIEM/syslog destination end to end (needs a local TLS syslog sink fixture)");
  it.todo("backup and integrations admin flows through the assembled app (owners' module suites cover them today)");
  it.todo("audit center UI against this backend (client-side; out of scope for the server integration suite)");
});
