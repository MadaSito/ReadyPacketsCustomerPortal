/**
 * /privacy — portal-specific privacy and cookie notice (public). Draft pending legal review.
 * Facts here must match the shipped portal; the canonical company policy lives on the marketing site.
 */
import { BRAND } from "@shared/brand";
import { ExternalPolicyLink, LegalLayout, LegalSection, MARKETING_POLICY_URLS, PRIVACY_CONTACT_EMAIL } from "../legal/LegalLayout";

export default function PrivacyPage() {
  return (
    <LegalLayout
      title="Portal privacy notice"
      description={`How the ${BRAND.companyShortName} customer portal handles your information, and the cookies it uses.`}
      canonical={{ href: MARKETING_POLICY_URLS.privacy, label: "Privacy & cookie notice" }}
    >
      <LegalSection id="who" title="Who operates this portal">
        <p>
          The {BRAND.companyShortName} customer portal is operated by {BRAND.companyLegalName}. You use it to manage your account, orders, files and
          messages with us.
        </p>
      </LegalSection>

      <LegalSection id="collect" title="What the portal collects">
        <ul>
          <li>Account details you give us: your name, email address and any profile information you add.</li>
          <li>
            Sign-in security data: your password is stored only as a one-way hash, and two-step verification secrets are stored encrypted. Recovery
            codes are shown to you once and are not displayed again.
          </li>
          <li>Content you submit: orders, intake answers, files, messages and support requests.</li>
          <li>
            Security and audit records: sign-ins, setting changes and other significant actions, with technical details such as time, network
            address and browser type. We use these to protect your account, investigate misuse and meet our obligations.
          </li>
        </ul>
        <p>We do not sell your personal information.</p>
      </LegalSection>

      <LegalSection id="cookies" title="Cookies">
        <p>The portal sets only the cookies it needs to keep you signed in securely:</p>
        <ul>
          <li>A session cookie that keeps you signed in. It is marked secure and HTTP-only, so page scripts cannot read it.</li>
          <li>A security cookie that protects form submissions against cross-site request forgery.</li>
        </ul>
        <p>Both are strictly necessary and are not used for tracking. Signing out ends your session on our servers. The portal does not use advertising cookies.</p>
      </LegalSection>

      <LegalSection id="analytics" title="Optional analytics">
        <p>
          If our administrators have enabled Microsoft Clarity or PostHog, you may be asked, on this page and the portal terms page only, whether to
          allow analytics for your current visit. Nothing loads unless you choose to allow it, and it never loads on sign-in, account, order, file,
          message or administration pages, or once you are signed in.
        </p>
        <p>
          Your choice is kept in memory for this browser tab only and is not stored on your device. You can withdraw it at any time using the
          preference panel at the bottom of the page. Analytics providers receive technical information such as your network address. Information
          they have already received cannot be recalled by withdrawing consent.
        </p>
      </LegalSection>

      <LegalSection id="retention" title="How long we keep information">
        <p>
          We keep account and order information for as long as your account is active and afterwards for as long as legal, tax or contractual
          obligations require. Security and audit records are kept under retention periods set by our administrators, and may be held longer when a
          legal hold applies. Retention periods for specific categories are described in the company's{" "}
          <ExternalPolicyLink href={MARKETING_POLICY_URLS.privacy}>Privacy & cookie notice</ExternalPolicyLink>.
        </p>
      </LegalSection>

      <LegalSection id="rights" title="Your choices and requests">
        <p>
          You can update your profile and security settings in the portal. To ask for a copy of your information, a correction or deletion, email{" "}
          <a href={`mailto:${PRIVACY_CONTACT_EMAIL}?subject=Privacy%20Rights%20Request`} className="text-action underline underline-offset-2">
            {PRIVACY_CONTACT_EMAIL}
          </a>{" "}
          with the subject “Privacy Rights Request”. We may need to verify your identity first.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="Contact">
        <p>
          Questions about this notice:{" "}
          <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`} className="text-action underline underline-offset-2">
            {PRIVACY_CONTACT_EMAIL}
          </a>
          , or use the <ExternalPolicyLink href={MARKETING_POLICY_URLS.contact}>contact page</ExternalPolicyLink>.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
