import { describe, expect, it } from "vitest";
import fixtureExample from "../fixtures.increment-08.example.json";
// @ts-expect-error The executable QA scripts are native JavaScript modules without declarations.
import { resolveIncrement08Scenarios, resolveQaScenarios } from "./routes.mjs";
// @ts-expect-error The executable QA scripts are native JavaScript modules without declarations.
import { INCREMENT_08_WIDTHS, increment08States } from "./increment-08.mjs";

const orderId = "01M00000000000000000000001";
const attemptId = "01M00000000000000000000002";
const inventory = [
  { id: "/register", path: "/register", access: "public", title: "Create an account" },
  { id: "/orders/new", path: "/orders/new", access: "customer", title: "New order" },
  { id: "/orders/:orderId", path: "/orders/:orderId", access: "customer", title: "Order" },
  { id: "/checkout/return", path: "/checkout/return", access: "customer", title: "Checkout status" },
  { id: "/admin/workflows", path: "/admin/workflows", access: "admin", title: "Workflows" },
];
const sessions = { customer: "customer.state.json", admin: "admin.state.json" };

describe("Increment 08 focused browser evidence", () => {
  it("covers the contract's 240–1440 px viewport range without changing the default route run", () => {
    expect(INCREMENT_08_WIDTHS).toEqual([240, 320, 390, 640, 768, 1024, 1280, 1440]);
    const baseline = resolveQaScenarios(inventory, { sessions }, "/qa", "/register");
    expect(baseline.cases).toHaveLength(1);
    expect(baseline.cases[0].ready).toBeUndefined();
    const focused = resolveIncrement08Scenarios(inventory, { sessions }, "/qa", "/register");
    expect(focused).toMatchObject({ suite: "increment-08", partial: true });
    expect(focused.cases).toHaveLength(1);
    expect(focused.cases[0]).toMatchObject({ name: "/register [anonymous; registration-names]", ready: expect.stringContaining("given-name") });
    expect(focused.missing).toEqual([expect.stringContaining("registration-billing")]);
  });

  it("reports all unregistered or unseeded target states without treating the default route as evidence", () => {
    const result = resolveIncrement08Scenarios(inventory, { sessions }, "/qa");
    expect(result.missing).toHaveLength(Object.keys(increment08States).length - 2);
    expect(result.cases).toEqual(expect.arrayContaining([expect.objectContaining({ name: expect.stringContaining("checkout-return-missing-target") })]));
    expect(result.missing).toEqual(expect.arrayContaining([
      expect.stringContaining("billing-settings-empty]: route is not registered"),
      expect.stringContaining("order-wizard]: supply a concrete same-origin fixture path"),
    ]));
    expect(() => resolveIncrement08Scenarios(inventory, { increment08: { unknown: {} } })).toThrow(/unknown state ID/);
    expect(Object.keys(fixtureExample.increment08)).toEqual(Object.keys(increment08States));
    expect(fixtureExample.checkoutSandbox).toBe(false);
    const placeholder = resolveIncrement08Scenarios(inventory, fixtureExample, "/qa", "order-wizard");
    expect(placeholder.cases).toEqual([]);
    expect(placeholder.missing[0]).toMatch(/seeded public ID/);
  });

  it("requires a concrete add-to query identifier, pins customer role and never prints fixture query values", () => {
    const run = (path: string) => resolveIncrement08Scenarios(inventory, {
      sessions, increment08: { "add-to-order": { role: "admin", path, ready: 'main :text-is("Already in this project")' } },
    }, "/qa", "add-to-order");
    const valid = run(`/orders/new?addTo=${orderId}`);
    expect(valid.cases).toEqual([expect.objectContaining({
      name: "/orders/new [customer; add-to-order]", role: "customer", path: `/orders/new?addTo=${orderId}`, storageState: "/qa/customer.state.json",
      ready: expect.stringContaining("packet-1-owned"),
    })]);
    for (const invalid of ["/orders/new?addTo=private-value", `/orders/new?addTo=${orderId}&addTo=${orderId}`, `//elsewhere.test/orders/new?addTo=${orderId}`]) {
      const result = run(invalid);
      expect(result.cases).toEqual([]);
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0]).not.toContain("private-value");
      expect(result.missing[0]).not.toContain(orderId);
    }
  });

  it("requires explicit disposable sandbox opt-in before opening a pending payment return", () => {
    const config = { sessions, increment08: {
      "checkout-return-pending": { path: `/checkout/return?attempt=${attemptId}`, ready: 'main :text-is("Waiting for payment confirmation")' },
    } };
    expect(resolveIncrement08Scenarios(inventory, config, "/qa", "checkout-return-pending").missing[0]).toMatch(/disposable sandbox/);
    expect(resolveIncrement08Scenarios(inventory, { ...config, checkoutSandbox: true }, "/qa", "checkout-return-pending").cases).toHaveLength(1);
    const invalid = resolveIncrement08Scenarios(inventory, {
      sessions, increment08: { "checkout-return-missing-target": { path: `/checkout/return?attempt=${attemptId}` } },
    }, "/qa", "checkout-return-missing-target");
    expect(invalid.cases).toEqual([]);
    expect(invalid.missing[0]).toMatch(/leave the checkout attempt and cart parameters absent/);
  });

  it("does not reach publish via a redirect or count the workflows page without dialog setup", () => {
    const run = (fixture: object) => resolveIncrement08Scenarios(inventory, {
      sessions, increment08: { "workflows-publish-dialog": { ready: '[role="dialog"]', ...fixture } },
    }, "/qa", "workflows-publish-dialog");
    expect(run({}).missing[0]).toMatch(/non-submitting steps/);
    expect(run({ redirectsTo: "/orders" }).missing[0]).toMatch(/must not redirect/);
    const steps = [{ testId: "publish-draft-row", key: "Enter" }];
    expect(run({ steps }).cases).toEqual([expect.objectContaining({ steps, role: "admin", ready: expect.stringContaining("publish-draft-confirm") })]);
  });

  it("uses different readiness markers and customer sessions for empty and saved account billing", () => {
    const result = resolveIncrement08Scenarios([
      { id: "/account/billing", path: "/account/billing", access: "customer", title: "Billing information" },
    ], fixtureExample, "/qa", "/account/billing");
    expect(result.missing).toEqual([]);
    expect(result.cases).toEqual([
      expect.objectContaining({ ready: expect.stringContaining('data-profile-state="empty"'), storageState: "/qa/customer-no-billing.state.json" }),
      expect.objectContaining({ ready: expect.stringContaining('data-profile-state="saved"'), storageState: "/qa/customer-with-billing.state.json" }),
    ]);
  });
});
