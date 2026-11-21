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
