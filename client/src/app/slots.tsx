/**
 * Slots filled by other features' shell components (lazy, so the shell never blocks on them and a failing
 * slot never breaks navigation). Features never import each other; only the app composes them.
 */
import { Component, Suspense, lazy, type ReactNode } from "react";

class SlotBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

function slot(node: ReactNode) {
  return (
    <SlotBoundary>
      <Suspense fallback={null}>{node}</Suspense>
    </SlotBoundary>
  );
}

const NotificationBellPopover = lazy(() => import("@/features/engagement/shell").then((m) => ({ default: m.NotificationBellPopover })));
const GlobalSearchBox = lazy(() => import("@/features/engagement/shell").then((m) => ({ default: m.GlobalSearchBox })));
/**
 * The consent banner is optional: resolved via glob so the shell builds before (or without) the
 * integrations feature shipping `consent.tsx`. Missing module → the slot renders nothing.
 */
type ConsentModule = { AnalyticsConsentSlot: () => ReactNode };
const consentLoaders = import.meta.glob<ConsentModule>("../features/integrations/consent.tsx");
const consentLoader = Object.values(consentLoaders)[0];
const AnalyticsConsentSlotImpl = consentLoader ? lazy(() => consentLoader().then((m) => ({ default: m.AnalyticsConsentSlot }))) : null;

export function NotificationSlot({ area }: { area: "customer" | "console" }) {
  return slot(<NotificationBellPopover area={area} />);
}
export function GlobalSearchSlot({ className }: { className?: string }) {
  return slot(<GlobalSearchBox className={className} />);
}
/**
 * "Sign in with SSO" (identity feature). Optional like the consent banner: missing module or a failure renders
 * nothing, and the identity component itself renders nothing unless SSO is configured and enabled.
 */
type SsoModule = { SsoSignInButton: (props: { next?: string }) => ReactNode };
const ssoLoaders = import.meta.glob<SsoModule>("../features/identity/sso/index.tsx");
const ssoLoader = Object.values(ssoLoaders)[0];
const SsoSignInImpl = ssoLoader ? lazy(() => ssoLoader().then((m) => ({ default: m.SsoSignInButton }))) : null;

export function SsoSignInSlot({ next }: { next?: string }) {
  return SsoSignInImpl ? slot(<SsoSignInImpl next={next} />) : null;
}
export function AnalyticsConsentSlot() {
  return AnalyticsConsentSlotImpl ? slot(<AnalyticsConsentSlotImpl />) : null;
}

/**
 * Optional increment-04 slots, resolved by glob so the shell builds before (or without) the owning feature.
 * Missing module or a thrown error renders nothing.
 */
function optionalSlot<P extends object>(loaders: Record<string, () => Promise<Record<string, unknown>>>, exportName: string) {
  const loader = Object.values(loaders)[0];
  if (!loader) return null;
  return lazy(() => loader().then((m) => ({ default: m[exportName] as (props: P) => ReactNode })));
}
const CookieConsentImpl = optionalSlot<object>(import.meta.glob<Record<string, unknown>>("../features/platform/consent/CookieConsent.tsx"), "CookieConsent");
const CustomerMaintenanceImpl = optionalSlot<object>(import.meta.glob<Record<string, unknown>>("../features/jobs/CustomerMaintenanceBanner.tsx"), "CustomerMaintenanceBanner");
const CartBadgeImpl = optionalSlot<object>(import.meta.glob<Record<string, unknown>>("../features/cart/CartBadge.tsx"), "CartBadge");

/** Cookie banner + preference centre (platform). Rendered first in every layout so it is first in tab order. */
export function CookieConsentSlot() {
  return CookieConsentImpl ? slot(<CookieConsentImpl />) : null;
}
/** Customer maintenance notice (jobs, decision 6): sign-in/register pages and the console shell. */
export function CustomerMaintenanceSlot() {
  return CustomerMaintenanceImpl ? slot(<CustomerMaintenanceImpl />) : null;
}
/** Cart item count next to the Cart navigation entry (cart feature). */
export function CartBadgeSlot() {
  return CartBadgeImpl ? slot(<CartBadgeImpl />) : null;
}

/**
 * Increment 06 D13: required-policy remediation forms (compliance feature) on the identity-owned /accept-policy
 * transition screen. The host page owns the h1 and an always-visible Sign out, so a failing slot cannot trap the user.
 */
const PolicyRemediationImpl = optionalSlot<object>(
  import.meta.glob<Record<string, unknown>>("../features/compliance/policyUpdates/PolicyEnforcementPrompt.tsx"),
  "PolicyEnforcementRemediation",
);
export function PolicyRemediationSlot() {
  return PolicyRemediationImpl ? slot(<PolicyRemediationImpl />) : null;
}

