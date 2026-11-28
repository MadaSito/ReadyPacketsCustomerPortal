/**
 * /terms — portal terms of use (public). Draft pending legal review; adapted from the account-security and
 * acceptable-use sections of the company's draft Terms of Service. Governing law, liability, payment and refund
 * terms are intentionally NOT restated here — the canonical Terms of Use on the marketing site govern.
 */
import { Link } from "wouter";
import { BRAND } from "@shared/brand";
import { EmailLink } from "@/ui";
import { ExternalPolicyLink, LegalLayout, LegalSection, MARKETING_POLICY_URLS, PRIVACY_CONTACT_EMAIL } from "../legal/LegalLayout";

export default function TermsPage() {
  return (
    <LegalLayout
      title="Portal terms of use"
      description={`The rules for using the ${BRAND.companyShortName} customer portal.`}
      canonical={{ href: MARKETING_POLICY_URLS.terms, label: "Terms of Use" }}
    >
      <LegalSection id="scope" title="What these terms cover">
        <p>
          These terms apply to your use of the {BRAND.companyShortName} customer portal operated by {BRAND.companyLegalName}. Our services, orders,
          payments and refunds are governed by the company's <ExternalPolicyLink href={MARKETING_POLICY_URLS.terms}>Terms of Use</ExternalPolicyLink>{" "}
          and <ExternalPolicyLink href={MARKETING_POLICY_URLS.refunds}>Refund Policy</ExternalPolicyLink>.
        </p>
      </LegalSection>

      <LegalSection id="account" title="Your account and its security">
        <ul>
          <li>Give accurate, complete information when you create and maintain your account.</li>
          <li>
            Keep your password, two-step verification device and recovery codes private. You are responsible for activity under your account.
          </li>
          <li>
            Tell us straight away at{" "}
            <EmailLink email={PRIVACY_CONTACT_EMAIL} />{" "}
            if you think someone else has used your account.
          </li>
          <li>We may suspend or close accounts that break these terms or put other customers or the portal at risk.</li>
        </ul>
      </LegalSection>

      <LegalSection id="use" title="Acceptable use">
        <p>When using the portal, you agree not to:</p>
        <ul>
          <li>use it for any unlawful purpose, or submit false, misleading or fraudulent information;</li>
          <li>try to access other people's accounts, systems or data;</li>
          <li>upload malicious code or harmful content;</li>
          <li>interfere with the portal's operation, or use automated tools to access it without our permission;</li>
          <li>use it to infringe anyone's intellectual property rights.</li>
        </ul>
      </LegalSection>

      <LegalSection id="advice" title="Not professional advice">
        <p>
          {BRAND.companyShortName} is not a law firm, registered investment adviser or accounting firm, and nothing in the portal is legal, financial
          or tax advice. Have documents reviewed by a qualified professional before relying on them for those purposes.
        </p>
      </LegalSection>

      <LegalSection id="records" title="Security monitoring">
        <p>
          To protect customers, we record security and audit events about portal use, as described in the{" "}
          <Link href="/privacy" className="text-action underline underline-offset-2">
            portal privacy notice
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection id="changes" title="Changes and contact">
        <p>
          We may update these terms. When we do, we will change the date at the top of this page. Questions:{" "}
          <EmailLink email={PRIVACY_CONTACT_EMAIL} />
          .
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
