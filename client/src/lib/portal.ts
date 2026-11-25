/**
 * Portal choice for staff and administrators (increment 07.1, D1/D2). Owner: UI foundation engineer.
 *
 * Staff and admins may open customer routes, but they do not own orders or carts (the server refuses with
 * CUSTOMER_ROLE_REQUIRED). A signed-in staff/admin who opens "/" is sent to /admin, unless they chose the
 * customer portal in THIS tab through the visible portal switch. The choice is a single flag in
 * sessionStorage (tab-scoped, gone when the tab closes); switching back to the console and signing out clear it.
 * An in-memory copy keeps the choice working where storage is unavailable (sandboxed frames, strict privacy).
 */
import type { UserRole } from "@shared/domain";

const KEY = "rp.portal.customerChosen";
let memory = false;

function storage(): Storage | null {
  try {
    // eslint-disable-next-line no-restricted-properties -- approved by /root (increment 07.1 D2): one tab-scoped flag "customer portal chosen"; no identifiers, profile data or credentials. Cleared on switch back and on sign-out.
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Staff and administrators (every role that is not a customer). */
export function isStaffRole(role: UserRole | null | undefined): boolean {
  return role === "staff" || role === "admin";
}

/** True when this tab chose to stay in the customer portal. */
export function readCustomerPortalChoice(): boolean {
  try {
    const value = storage()?.getItem(KEY);
    return value === "1" || ((value === null || value === undefined) && memory);
  } catch {
    return memory;
  }
}

/** Record (true) or clear (false) the customer-portal choice for this tab. */
export function setCustomerPortalChoice(chosen: boolean): void {
  memory = chosen;
  try {
    if (chosen) storage()?.setItem(KEY, "1");
    else storage()?.removeItem(KEY);
  } catch {
    /* storage unavailable: the in-memory copy still applies for this page lifetime */
  }
}

export function clearCustomerPortalChoice(): void {
  setCustomerPortalChoice(false);
}

export type PortalArea = "customer" | "console";

/** Label of the switch that leaves `area`: "Admin portal" / "Staff portal" from the customer shell, "Customer portal" from the console. */
export function portalSwitchLabel(role: UserRole, area: PortalArea): string {
  if (area === "console") return "Customer portal";
  return role === "admin" ? "Admin portal" : "Staff portal";
}

/** Where the switch that leaves `area` goes. */
export function portalSwitchHref(area: PortalArea): string {
  return area === "console" ? "/" : "/admin";
}

/** Console route that opens the "New order for a customer" dialog (D5). */
export const NEW_ORDER_FOR_CUSTOMER_HREF = "/admin/orders?new=1";
