import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MeResult, MeUser } from "@/lib/authApi";
import { clearCustomerPortalChoice, isStaffRole, portalSwitchHref, portalSwitchLabel, readCustomerPortalChoice, setCustomerPortalChoice } from "@/lib/portal";
import { expectNoAxeViolations, fakeAuthApi, renderUi } from "@/ui/testing";
import { NEW_ORDER_FOR_CUSTOMER_HREF, PortalSwitch, StaffOrderHandoff, StaffPortalNotice, useIsStaffViewer } from "./portal";

const user = (role: MeUser["role"]): MeUser => ({ publicId: "u1", role, name: "Avery Example", email: "a@example.test", status: "active" });
const full = (role: MeUser["role"]): MeResult => ({ user: user(role), state: "full", pendingSteps: [], nextStep: null });
const as = (role: MeUser["role"]) => ({ api: fakeAuthApi({ me: async () => full(role) }) });

afterEach(() => clearCustomerPortalChoice());

describe("portal helpers", () => {
  it("labels and targets the switch by role and shell", () => {
    expect(portalSwitchLabel("admin", "customer")).toBe("Admin portal");
    expect(portalSwitchLabel("staff", "customer")).toBe("Staff portal");
    expect(portalSwitchLabel("admin", "console")).toBe("Customer portal");
    expect(portalSwitchLabel("staff", "console")).toBe("Customer portal");
    expect(portalSwitchHref("customer")).toBe("/admin");
    expect(portalSwitchHref("console")).toBe("/");
    expect(isStaffRole("admin")).toBe(true);
    expect(isStaffRole("staff")).toBe(true);
    expect(isStaffRole("customer")).toBe(false);
    expect(isStaffRole(undefined)).toBe(false);
  });

  it("keeps the customer-portal choice per tab and clears it", () => {
    expect(readCustomerPortalChoice()).toBe(false);
    setCustomerPortalChoice(true);
    expect(readCustomerPortalChoice()).toBe(true);
    clearCustomerPortalChoice();
    expect(readCustomerPortalChoice()).toBe(false);
  });
});

function Probe() {
  return <p>{useIsStaffViewer() ? "staff viewer" : "not staff"}</p>;
}

describe("portal components", () => {
  it("useIsStaffViewer is true for staff and admin, false for customers", async () => {
    for (const [role, text] of [["admin", "staff viewer"], ["staff", "staff viewer"], ["customer", "not staff"]] as const) {
      const r = renderUi(<Probe />, as(role));
      expect(await screen.findByText(text)).toBeInTheDocument();
      r.unmount();
    }
  });

  it("switch from the console records the customer-portal choice; switch from the customer shell clears it", async () => {
    const a = renderUi(<PortalSwitch area="console" />, as("admin"));
    const toCustomer = await screen.findByRole("link", { name: "Customer portal" });
    expect(toCustomer).toHaveAttribute("href", "/");
    fireEvent.click(toCustomer);
    expect(readCustomerPortalChoice()).toBe(true);
    a.unmount();
    renderUi(<PortalSwitch area="customer" />, as("admin"));
    const toAdmin = await screen.findByRole("link", { name: "Admin portal" });
    expect(toAdmin).toHaveAttribute("href", "/admin");
    fireEvent.click(toAdmin);
    expect(readCustomerPortalChoice()).toBe(false);
  });

  it("switch renders nothing for a customer", async () => {
    const { container } = renderUi(<><PortalSwitch area="customer" /><Probe /></>, as("customer"));
    await screen.findByText("not staff");
    expect(container.querySelector("[data-portal-switch]")).toBeNull();
  });

  it("handoff panel: heading, explanation, New order for a customer and the portal switch", async () => {
    const { container } = renderUi(<StaffOrderHandoff />, as("staff"));
    expect(await screen.findByRole("link", { name: "Staff portal" })).toHaveAttribute("href", "/admin");
    expect(screen.getByRole("heading", { level: 1, name: "Orders are placed for a customer" })).toBeInTheDocument();
    expect(screen.getByText(/signed in as a staff member/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New order for a customer" })).toHaveAttribute("href", NEW_ORDER_FOR_CUSTOMER_HREF);
    expect(screen.getByRole("region", { name: "Orders are placed for a customer" })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("handoff panel accepts a custom title, body and heading level", async () => {
    renderUi(<StaffOrderHandoff title="Your cart is for customers" body={<p>Custom body.</p>} headingLevel={2} />, as("admin"));
    expect(await screen.findByRole("heading", { level: 2, name: "Your cart is for customers" })).toBeInTheDocument();
    expect(screen.getByText("Custom body.")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Admin portal" })).toBeInTheDocument();
  });

  it("notice: shown to staff/admin with both actions, absent for customers", async () => {
    const a = renderUi(<StaffPortalNotice />, as("admin"));
    expect(await screen.findByText(/viewing the customer portal as an administrator/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New order for a customer" })).toHaveAttribute("href", "/admin/orders?new=1");
    expect(screen.getByRole("link", { name: "Admin portal" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /dismiss|close/i })).toBeNull();
    await expectNoAxeViolations(a.container);
    a.unmount();
    const { container } = renderUi(<><StaffPortalNotice /><Probe /></>, as("customer"));
    await screen.findByText("not staff");
    expect(container.querySelector("[data-testid=staff-portal-notice]")).toBeNull();
  });
});
