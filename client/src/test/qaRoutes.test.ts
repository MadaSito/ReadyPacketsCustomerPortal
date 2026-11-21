/** Export real route metadata through Vitest/Vite (supports import.meta.glob in feature registration). */
import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { ALL_ROUTES, CUSTOMER_TABS, ORDER_TABS } from "@/app/registry";
import { documentTitle } from "@/app/RouteFocus";

it("provides the browser QA route catalogue", async () => {
  const routes = ALL_ROUTES.map(({ path, access, title }) => ({ id: path, path, access, title: documentTitle(title) }));
  expect(new Set(routes.map(({ path }) => path)).size).toBe(routes.length);
  const extras = [
    ...ORDER_TABS.filter(({ access }) => access === "customer").map(({ key }) => ({ id: `/orders/:orderId/${key}`, path: `/orders/:orderId/${key}`, access: "customer", title: documentTitle("Order") })),
    ...ORDER_TABS.map(({ key, access }) => ({ id: `/admin/orders/:orderId/${key}`, path: `/admin/orders/:orderId/${key}`, access: access === "admin" ? "admin" : "staff", title: documentTitle("Order") })),
    ...CUSTOMER_TABS.map(({ key, access, label }) => ({ id: `/admin/customers/:customerId#${key}`, path: "/admin/customers/:customerId", access, title: documentTitle("Customer"), tab: label })),
    { id: "/__qa_missing_route__", path: "/__qa_missing_route__", access: "public", title: documentTitle("Page not found") },
  ];
  const output = process.env.RP_QA_INVENTORY_OUTPUT;
  if (output) await writeFile(output, JSON.stringify([...routes, ...extras]), { flag: "wx", mode: 0o600 });
});
