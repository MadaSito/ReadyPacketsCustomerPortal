/**
 * Staff/admin portal pieces shared by the shells and by features (increment 07.1, D1/D3/D4).
 * Owner: UI foundation engineer. Features may import from "@/app/portal".
 *
 *   const staff = useIsStaffViewer();                  // true for a signed-in staff/admin session
 *   if (staff) return <StaffOrderHandoff />;           // /orders/new, /cart, /cart/checkout
 *   <PortalSwitch area="customer" />                   // "Admin portal" / "Staff portal" ↔ "Customer portal"
 *   <Link href={NEW_ORDER_FOR_CUSTOMER_HREF}>…</Link>  // /admin/orders?new=1
 *
 * No server rule changes here: staff and admins do not own orders or carts (CUSTOMER_ROLE_REQUIRED); they create
 * orders FOR a customer from the console.
 */
import { ArrowLeftRight, Info, Plus } from "lucide-react";
import { useId, type ReactNode } from "react";
import { Link } from "wouter";
import type { UserRole } from "@shared/domain";
import {
  isStaffRole,
  NEW_ORDER_FOR_CUSTOMER_HREF,
  portalSwitchHref,
  portalSwitchLabel,
  setCustomerPortalChoice,
  type PortalArea,
} from "@/lib/portal";
import { useSession } from "@/lib/session";
import { Button, buttonClasses } from "@/ui";
import { cn } from "@/ui/cn";

export { isStaffRole, NEW_ORDER_FOR_CUSTOMER_HREF, portalSwitchLabel } from "@/lib/portal";

/** True while a full staff/admin session is signed in (false for customers, anonymous or loading). */
export function useIsStaffViewer(): boolean {
  const { view } = useSession();
  return view.status === "full" && isStaffRole(view.role);
}

/** The signed-in role (full sessions only), or null. */
export function useViewerRole(): UserRole | null {
  const { view } = useSession();
  return view.status === "full" ? view.role : null;
}

export interface PortalSwitchProps {
  /** The shell this switch is shown in; the link leads to the other portal. */
  area: PortalArea;
  /** Defaults to the signed-in role. */
  role?: UserRole;
  /** "button": secondary button look; "nav": navigation-rail entry; "inline": plain text link. */
  appearance?: "button" | "nav" | "inline";
  className?: string;
  onNavigate?: () => void;
}

/**
 * The visible portal switch. Leaving the console records "customer portal chosen" for this tab (so "/" stays
 * in the customer portal); leaving the customer portal clears it. Renders nothing for customers.
 */
export function PortalSwitch({ area, role, appearance = "button", className, onNavigate }: PortalSwitchProps) {
  const viewerRole = useViewerRole();
  const effective = role ?? viewerRole;
  if (!effective || !isStaffRole(effective)) return null;
  const label = portalSwitchLabel(effective, area);
  const onClick = () => {
    setCustomerPortalChoice(area === "console");
    onNavigate?.();
  };
  const classes =
    appearance === "nav"
      ? "rp-nav-item flex min-h-11 min-w-0 items-center gap-3 rounded-[var(--radius-control)] px-3 text-sm"
      : appearance === "inline"
        ? "inline-flex min-h-6 items-center gap-1.5 font-semibold text-action underline underline-offset-2 hover:text-action-hover"
        : buttonClasses("secondary", "sm");
  return (
    <Link href={portalSwitchHref(area)} onClick={onClick} className={cn(classes, className)} data-portal-switch={area}>
      <ArrowLeftRight aria-hidden="true" className={appearance === "nav" ? "size-5 shrink-0" : "size-4 shrink-0"} />
      <span className="min-w-0 truncate">{label}</span>
    </Link>
  );
}

/** Primary "New order for a customer" link to the console dialog (D5). */
export function NewOrderForCustomerLink({ className, variant = "primary", size = "md" }: { className?: string; variant?: "primary" | "secondary"; size?: "sm" | "md" }) {
  return (
    <Button asChild variant={variant} size={size} className={className}>
      <Link href={NEW_ORDER_FOR_CUSTOMER_HREF}>
        <Plus aria-hidden="true" />
        New order for a customer
      </Link>
    </Button>
  );
}

function roleNoun(role: UserRole | null): string {
  return role === "admin" ? "an administrator" : "a staff member";
}

export interface StaffOrderHandoffProps {
  /** Heading text. Default: "Orders are placed for a customer". */
  title?: string;
  /** Explanation under the heading; a sensible default is used when omitted. */
  body?: ReactNode;
  /** Heading level; pages that render this as their only content use 1 (the default). */
  headingLevel?: 1 | 2;
  className?: string;
}

/**
 * Friendly replacement for customer-only screens (order wizard, cart, checkout) when a staff/admin opens them
 * (D4): what is happening, the "New order for a customer" action and the portal switch.
 */
export function StaffOrderHandoff({ title = "Orders are placed for a customer", body, headingLevel = 1, className }: StaffOrderHandoffProps) {
  const role = useViewerRole();
  const H = `h${headingLevel}` as const;
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={cn("mx-auto w-full max-w-2xl min-w-0", className)} data-testid="staff-order-handoff">
      <div className="rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-[var(--shadow-card)] rp-forced-border sm:p-8">
        <span aria-hidden="true" className="mb-4 inline-flex size-11 items-center justify-center rounded-full bg-info-soft text-info">
          <Info className="size-5" />
        </span>
        <H id={titleId} className={cn("font-semibold text-balance break-words text-ink", headingLevel === 1 ? "text-2xl" : "text-xl")}>
          {title}
        </H>
        <div className="mt-3 space-y-2 text-[0.9375rem] text-body">
          {body ?? (
            <>
              <p>You are signed in as {roleNoun(role)}. Orders, carts and checkout belong to customer accounts, so this screen is only available to customers.</p>
              <p>To place an order on a customer&rsquo;s behalf, create it from the console. It then appears in that customer&rsquo;s portal.</p>
            </>
          )}
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <NewOrderForCustomerLink />
          <PortalSwitch area="customer" className="min-h-11 px-4 text-[0.9375rem]" />
        </div>
      </div>
    </section>
  );
}

/**
 * Compact, non-dismissible notice at the top of the customer shell for staff/admin viewers (D3).
 * Renders nothing for customers.
 */
export function StaffPortalNotice({ role: roleProp }: { role?: UserRole } = {}) {
  const viewerRole = useViewerRole();
  const role = roleProp ?? viewerRole;
  if (!role || !isStaffRole(role)) return null;
  return (
    <div className="border-b border-info/40 bg-info-soft" data-testid="staff-portal-notice">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:px-6 lg:px-8">
        <p className="flex min-w-0 flex-[1_1_18rem] items-start gap-2 text-sm text-ink">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-info" />
          <span className="min-w-0">
            <span className="font-semibold">You are viewing the customer portal as {roleNoun(role)}.</span> Orders, carts and checkout belong to customer accounts.
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <NewOrderForCustomerLink variant="secondary" size="sm" />
          {/* 07.1: from md up the top bar carries the switch; only repeat it here where the top-bar one is hidden. */}
          <PortalSwitch area="customer" role={role} className="md:hidden" />
        </div>
      </div>
    </div>
  );
}
