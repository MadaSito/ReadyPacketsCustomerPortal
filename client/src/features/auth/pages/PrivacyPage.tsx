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

      <LegalSection id="recipients" title="Who receives your information">
        <ul>
          <li>
            <strong>Production pipeline (when an order is started):</strong> If our administrators have enabled the {BRAND.companyShortName}{" "}
            production pipeline and a member of our team starts production on your order, the portal sends order metadata — your customer reference,
            the order reference, the packets and tiers in the order, and production run settings — together with the order owner&apos;s name and email
            address over HTTPS to the configured production pipeline so your deliverables can be prepared. Starting Phase II for the same order sends
            only your customer reference, the order reference and the run mode. While an outbound delivery is queued or retrying, that payload is
            stored encrypted on our servers and cleared once delivery finishes.
          </li>
          <li>
            <strong>Transactional email (if enabled):</strong> Account invitations, password reset links, and order, support or billing notifications
            are sent through the outbound SMTP mail server and/or <strong>Microsoft Graph</strong> mail service configured by our administrators. If
            an audit-copy mailbox or bounded message-preview retention is enabled, single-use verification, invitation and password reset links are
            redacted in those copies.
          </li>
          <li>
            <strong>Cloud storage copies and Microsoft SharePoint sync (if enabled):</strong> Accepted order files and verified encrypted backups may
            be copied to cloud storage destinations configured by our administrators — including <strong>Amazon S3</strong>, <strong>Wasabi</strong>,{" "}
            <strong>Backblaze B2</strong>, <strong>Azure Blob Storage</strong>, <strong>Dropbox</strong>, <strong>Google Drive</strong>,{" "}
            <strong>Microsoft OneDrive for Business</strong>, and <strong>Microsoft SharePoint</strong> document libraries (via{" "}
            <strong>Microsoft Graph</strong>) — using folder labels that include abbreviated customer name, customer reference and order reference. If
            SharePoint order sync is enabled, order summary records (order reference, customer reference, status, packets and tiers, totals, dates, and
            an optional portal link) are synchronised to a SharePoint list through Microsoft Graph.
          </li>
          <li>
            <strong>Enterprise single sign-on and automation webhooks (if enabled):</strong> Where <strong>Microsoft Entra ID</strong> single sign-on
            is enabled for an account, authentication tokens are exchanged with Microsoft&apos;s identity endpoints. Where administrators configure
            outbound HTTPS automation webhooks, allow-listed event metadata may be delivered to those endpoints.
          </li>
          <li>
            <strong>Hosted online payment providers (if enabled):</strong> When our administrators enable online checkout via{" "}
            <strong>Stripe Checkout</strong> or <strong>Square Payment Links</strong> and you choose to pay an invoice online, the portal sends
            bounded checkout metadata — internal payment attempt, invoice and order identifiers, invoice number, and the balance due and currency —
            over HTTPS to that provider and redirects your browser to the provider&apos;s hosted payment page. Payment card and wallet details are
            collected directly by the hosted provider and never touch or are stored on our servers.
          </li>
          <li>
            <strong>Security monitoring (if enabled):</strong> Pseudonymised security and audit events may be forwarded over TLS to a security
            monitoring (SIEM) receiver configured by our administrators.
          </li>
        </ul>
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
          legal hold applies. Removing or superseding a file in the portal does not automatically delete copies already written to configured cloud
          storage destinations; retention and deletion of those remote copies are managed by our administrators in the destination storage accounts.
          Retention periods for specific categories are described in the company&apos;s{" "}
          <ExternalPolicyLink href={MARKETING_POLICY_URLS.privacy}>Privacy &amp; cookie notice</ExternalPolicyLink>.
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
