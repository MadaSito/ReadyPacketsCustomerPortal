/**
 * Layout for the portal's public legal notices (/privacy, /terms). Owner: ui_foundation_engineer.
 *
 * These are the ONLY routes on which consent-gated analytics may load (integrations/consent.tsx allowlist), so the
 * pages must stay free of private data: no session-specific content, no query-string driven rendering. The fixed
 * consent panel overlays the bottom of the viewport, so the article reserves bottom space for it.
 */
import type { ReactNode } from "react";
import { Link } from "wouter";
import { ExternalLink } from "lucide-react";
import { BRAND } from "@shared/brand";
import { BrandLogo, Callout, PageHeader } from "@/ui";
import { useSession } from "@/lib/session";
import { ThemeToggle } from "@/app/shell/common";

export const MARKETING_POLICY_URLS = {
  privacy: `${BRAND.marketingUrl}/privacy.html`,
  terms: `${BRAND.marketingUrl}/terms/`,
  refunds: `${BRAND.marketingUrl}/refunds/`,
  accessibility: `${BRAND.marketingUrl}/accessibility.html`,
  contact: `${BRAND.marketingUrl}/contact.html`,
} as const;

/** Contact address published in the company's supplied privacy policy (legacy policy package, 2026-08-19). */
export const PRIVACY_CONTACT_EMAIL = "info@readypackets.com";

/** Last edit of the portal notice text. Update together with the content. */
export const NOTICE_UPDATED = "2026-11-20";

export function ExternalPolicyLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 items-center gap-1 text-action underline underline-offset-2">
      {children}
      <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function LegalSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} className="min-w-0 border-t border-line pt-6">
      <h2 id={`${id}-h`} className="text-lg font-semibold text-ink">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-[0.9375rem] leading-relaxed text-body [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">{children}</div>
    </section>
  );
}

export interface LegalLayoutProps {
  title: string;
  description: string;
  /** Canonical company policy on the marketing site that governs where this notice is silent. */
  canonical: { href: string; label: string };
  children: ReactNode;
}

export function LegalLayout({ title, description, canonical, children }: LegalLayoutProps) {
  const session = useSession();
  const signedIn = session.view.status === "full";
  return (
    <div className="flex flex-1 flex-col">
      {signedIn ? null : (
        <div className="flex items-center justify-between gap-3 px-4 pt-4 sm:px-8 sm:pt-6">
          <Link href="/sign-in" aria-label="ReadyPackets sign in" className="inline-flex rounded">
            <BrandLogo label="" className="w-44 sm:w-52" />
          </Link>
          <ThemeToggle />
        </div>
      )}
      <article className="mx-auto w-full min-w-0 max-w-3xl px-4 pb-48 pt-8 sm:px-6 sm:pb-40 sm:pt-12">
        <PageHeader title={title} description={description} meta={<span className="text-sm text-muted">Updated {NOTICE_UPDATED}</span>} />
        <Callout tone="warning" title="Draft — pending legal review">
          This portal notice is a working draft and has not yet been reviewed by counsel. Where it is silent or differs, the company's published{" "}
          <ExternalPolicyLink href={canonical.href}>{canonical.label}</ExternalPolicyLink> applies.
        </Callout>
        <div className="mt-8 space-y-8">{children}</div>
        <nav aria-label="Related policies" className="mt-10 border-t border-line pt-6 text-sm">
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            <li>
              <Link href="/privacy" className="inline-flex min-h-6 items-center text-action underline underline-offset-2">
                Portal privacy notice
              </Link>
            </li>
            <li>
              <Link href="/terms" className="inline-flex min-h-6 items-center text-action underline underline-offset-2">
                Portal terms of use
              </Link>
            </li>
            <li>
              <ExternalPolicyLink href={MARKETING_POLICY_URLS.refunds}>Refund Policy</ExternalPolicyLink>
            </li>
            <li>
              <ExternalPolicyLink href={MARKETING_POLICY_URLS.accessibility}>Accessibility</ExternalPolicyLink>
            </li>
          </ul>
        </nav>
      </article>
    </div>
  );
}
