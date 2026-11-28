import { describe, expect, it } from "vitest";
import fixtureExample from "../fixtures.increment-09.example.json";
// @ts-expect-error Native JavaScript QA modules have no declarations.
import { INCREMENT_09, increment09States } from "./increment-09.mjs";
// @ts-expect-error Native JavaScript QA modules have no declarations.
import { resolveIncrement09Scenarios } from "./routes.mjs";

const inventory = [
  { id: "/admin/trash", path: "/admin/trash", access: "admin", title: "Trash" },
  { id: "/admin/orders", path: "/admin/orders", access: "staff", title: "Orders" },
  { id: "/admin/customers/:customerId", path: "/admin/customers/:customerId", access: "staff", title: "Customer" },
  { id: "/admin/email-templates/:templateKey", path: "/admin/email-templates/:templateKey", access: "admin", title: "Email template" },
];

describe("Increment 09 sweep evidence", () => {
  it("keeps fixture names synchronized and missing routes separate from page results", () => {
    expect(Object.keys(fixtureExample.increment09)).toEqual(Object.keys(increment09States));
    const missing = resolveIncrement09Scenarios([], fixtureExample, "/qa", "trash-orders");
    expect(missing).toMatchObject({ suite: INCREMENT_09, partial: true, cases: [] });
    expect(missing.missing).toEqual([expect.stringContaining("route is not registered")]);
  });

  it("requires an actual customer fixture and pins the dialog-opening steps and admin session", () => {
    const key = "customer-move-to-trash-dialog";
    const path = "/admin/customers/01M00000000000000000000001";
    const placeholder = resolveIncrement09Scenarios(inventory, fixtureExample, "/qa", key);
    expect(placeholder.missing).toEqual([expect.stringContaining("seeded public ID")]);
    const steps = [{ role: "button", name: "Move to trash" }];
    const ready = resolveIncrement09Scenarios(inventory, {
      ...fixtureExample, increment09: { [key]: { path, steps: [], role: "customer" } },
    }, "/qa", key);
    expect(ready.missing).toEqual([]);
    expect(ready.cases).toEqual([expect.objectContaining({ path, steps, role: "admin", storageState: "/qa/admin.state.json" })]);
  });

  it("supports an editor template key rather than requiring all parameterized routes to use ULIDs", () => {
    const result = resolveIncrement09Scenarios(inventory, fixtureExample, "/qa", "mail-template-preview");
    expect(result.cases).toEqual([expect.objectContaining({
      path: "/admin/email-templates/orders.confirmed", ready: expect.stringContaining("iframe"),
    })]);
  });

  it("never installs fixture-supplied actions in the trash and move-to-trash dialogs", () => {
    const steps = [{ role: "button", name: "Delete permanently" }];
    const config = { ...fixtureExample, increment09: { "trash-purge-dialog": { steps }, "order-row-move-to-trash": { steps } } };
    expect(resolveIncrement09Scenarios(inventory, config, "/qa", "trash-purge-dialog").cases).toEqual([expect.objectContaining({
      steps: [{ role: "button", name: "Delete permanently ", namePrefix: true, first: true }],
      ready: expect.stringContaining("button:disabled"),
    })]);
    expect(resolveIncrement09Scenarios(inventory, config, "/qa", "order-row-move-to-trash").cases).toEqual([expect.objectContaining({
      steps: [{ role: "button", name: "Move to trash:", namePrefix: true, first: true }],
      ready: expect.stringContaining("alertdialog"),
    })]);
  });
});
