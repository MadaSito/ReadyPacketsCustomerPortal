/**
 * Disabled Provider Scaffolds (`saml`, `sharepoint`).
 *
 * Neither provider processes external assertions or executes remote file sync in this release:
 *  - SAML 2.0 SSO: clearly disabled scaffold; stores optional non-active planning metadata only,
 *    refuses activation (`Not available in this release — local sign-in with MFA is the only active method`),
 *    and publishes the mandatory security requirements for a future implementation.
 *  - SharePoint / Microsoft 365 File Sync: disabled scaffold + truthful target status only.
 */
import type { ModuleDeps } from "../../container.js";
import { DomainError, validation } from "../../core/errors.js";
import type { SessionPrincipal } from "../../core/types.js";
import { readSetting, writeSetting } from "../platform/index.js";
import { assertIntegrationsManageInTx, assertIntegrationsManagePreflight } from "./authz.js";
import { INTEGRATIONS_SAML_SCAFFOLD, samlScaffoldSettingSchema, type SamlScaffoldSetting } from "./settings.js";

export const SAML_RELEASE_BANNER =
  "Not available in this release — local sign-in with MFA is the only active method.";

export const SAML_FUTURE_SECURITY_REQUIREMENTS = [
  "Verify XML cryptographic signatures strictly against pinned IdP signing certificates over the exact Assertion ID (defending against XML Signature Wrapping).",
  "Enforce strict Audience, Recipient, Destination, Issuer, NotBefore and NotOnOrAfter validation with bounded clock skew.",
  "Bind SP-initiated AuthnRequest IDs (InResponseTo) and enforce a durable, atomic Assertion ID replay cache across workers.",
  "Never auto-link accounts silently by email address; local-to-SAML and SAML-to-local transitions require explicit step-up verification, session revocation and durable audit.",
  "Enforce ReadyPackets mandatory MFA assurance policy regardless of IdP authentication unless an explicitly verified hardware/phishing-resistant AuthnContext is approved, and retain a local MFA break-glass administrator.",
  "Authoritative logout must revoke the ReadyPackets server-side session (`__Host-rp_session`) rather than clearing secondary cookies.",
] as const;

export const SHAREPOINT_TARGET_REQUIREMENTS = [
  "Documented Day-2 target — Microsoft 365 / SharePoint remote file sync is disabled in this release.",
  "Requires dedicated app-only Entra identity with Sites.Selected resource grants (never broad tenant-wide Files.ReadWrite.All without explicit isolated sync boundary).",
  "Discovery and chunked uploads must traverse the pinned egress policy (HTTPS 443, no automatic redirects) with SHA-256 byte readback verification before marking transfer complete.",
  "Sanitized friendly folder labels (first 2 characters of first name + last name + customer reference + order label) remain display metadata only — never authorization authority or logged PII.",
] as const;

export interface SamlScaffoldView {
  state: "disabled";
  availableInRelease: false;
  releaseBanner: string;
  metadata: SamlScaffoldSetting;
  securityRequirements: readonly string[];
}

export interface UpdateSamlScaffoldInput extends SamlScaffoldSetting {
  /** Must not be `true`; attempting to enable SAML throws `NOT_CONFIGURED / SAML_NOT_AVAILABLE_IN_RELEASE`. */
  enabled?: boolean;
}

export interface SharePointScaffoldView {
  state: "disabled";
  availableInRelease: false;
  summary: string;
  targetRequirements: readonly string[];
}

export interface ScaffoldsService {
  getSamlScaffold(): Promise<SamlScaffoldView>;
  updateSamlMetadata(principal: SessionPrincipal, input: UpdateSamlScaffoldInput): Promise<SamlScaffoldView>;
  getSharePointScaffold(): Promise<SharePointScaffoldView>;
}

export function createScaffoldsService(deps: ModuleDeps): ScaffoldsService {
  return {
    async getSamlScaffold(): Promise<SamlScaffoldView> {
      const metadata = await readSetting(deps.settings, INTEGRATIONS_SAML_SCAFFOLD);
      return {
        state: "disabled",
        availableInRelease: false,
        releaseBanner: SAML_RELEASE_BANNER,
        metadata,
        securityRequirements: SAML_FUTURE_SECURITY_REQUIREMENTS,
      };
    },

    async updateSamlMetadata(principal, input): Promise<SamlScaffoldView> {
      const now = deps.clock.now();
      assertIntegrationsManagePreflight(principal, now);

      if (input.enabled === true) {
        await deps.audit.record({
          category: "security",
          eventName: "integration.saml.enable_refused",
          action: "update",
          outcome: "refused",
          severity: "WARN",
          reasonCode: "SAML_NOT_AVAILABLE_IN_RELEASE",
          provider: "saml",
          resource: { type: "integration_provider", publicId: "saml" },
        });
        throw new DomainError(
          "NOT_CONFIGURED",
          "SAML_NOT_AVAILABLE_IN_RELEASE",
          SAML_RELEASE_BANNER,
        );
      }

      const parsed = samlScaffoldSettingSchema.safeParse({
        idpEntityId: input.idpEntityId,
        idpSsoUrl: input.idpSsoUrl,
        spEntityId: input.spEntityId,
        nameIdFormat: input.nameIdFormat,
      });
      if (!parsed.success) {
        throw validation(
          "INVALID_SAML_METADATA",
          parsed.error.issues[0]?.message ?? "Invalid SAML planning metadata.",
        );
      }

      await deps.db.transaction(async (tx) => {
        await assertIntegrationsManageInTx(deps, principal, tx);
        await writeSetting(deps.settings, INTEGRATIONS_SAML_SCAFFOLD, parsed.data, tx);
        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.saml.scaffold_updated",
            action: "update",
            outcome: "completed",
            severity: "INFO",
            provider: "saml",
            resource: { type: "integration_provider", publicId: "saml" },
            attributes: {
              has_idp_entity: parsed.data.idpEntityId !== "",
              has_sso_url: parsed.data.idpSsoUrl !== "",
              active: false,
            },
          },
          tx,
        );
      });

      return this.getSamlScaffold();
    },

    async getSharePointScaffold(): Promise<SharePointScaffoldView> {
      return {
        state: "disabled",
        availableInRelease: false,
        summary: "Disabled scaffold — SharePoint / Microsoft 365 file sync is a documented target and is not active in this release.",
        targetRequirements: SHAREPOINT_TARGET_REQUIREMENTS,
      };
    },
  };
}
