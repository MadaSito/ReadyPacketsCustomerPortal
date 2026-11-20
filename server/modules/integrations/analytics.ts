/**
 * Consent-Gated Public-Route Analytics Service (`services.integrations.analytics` & `analyticsCsp`).
 *
 * Security & privacy invariants:
 *  - Both Microsoft Clarity and PostHog are OFF by default.
 *  - Identifiers only — never raw `<script>`, HTML snippets, inline code or arbitrary URLs.
 *  - Route allowlist is fixed (`["/privacy", "/terms"]`) and read-only; authentication, security,
 *    recovery, customer data, file, message, invoice and all `/admin` routes are permanently excluded.
 *  - `analyticsCsp(pathname)` returns exact HTTPS `scriptSrc` / `connectSrc` origins ONLY when at least
 *    one provider is enabled+valid AND `pathname` is in the strict exact allowlist.
 *  - PostHog uses direct capture requests (`connectSrc` only; zero vendor SDK executed in portal JS realm).
 */
import type { ModuleDeps } from "../../container.js";
import { validation } from "../../core/errors.js";
import type { SessionPrincipal } from "../../core/types.js";
import { readSetting, writeSetting } from "../platform/index.js";
import { flagKey } from "../platform/settingsRegistry.js";
import { assertIntegrationsManageInTx, assertIntegrationsManagePreflight } from "./authz.js";
import {
  ALLOWED_ANALYTICS_PATHS,
  CLARITY_CONNECT_ORIGINS,
  CLARITY_SCRIPT_ORIGINS,
  INTEGRATIONS_CLARITY_FLAG,
  INTEGRATIONS_CLARITY_PROJECT_ID,
  INTEGRATIONS_POSTHOG_ALLOWED_ORIGINS,
  INTEGRATIONS_POSTHOG_FLAG,
  INTEGRATIONS_POSTHOG_HOST,
  INTEGRATIONS_POSTHOG_PROJECT_KEY,
  isAllowedAnalyticsPathname,
  isSafeAnalyticsOrigin,
  isValidClarityProjectId,
  isValidPostHogProjectKey,
  PERMANENTLY_EXCLUDED_ANALYTICS_PREFIXES,
  POSTHOG_CLOUD_ORIGINS,
  readIntegrationFlag,
} from "./settings.js";

export interface AnalyticsCspPolicy {
  readonly scriptSrc?: readonly string[];
  readonly connectSrc?: readonly string[];
}

export interface PublicAnalyticsConfig {
  clarity: {
    enabled: boolean;
    projectId: string | null;
  };
  posthog: {
    enabled: boolean;
    key: string | null;
    host: string | null;
  };
}

export interface AdminAnalyticsConfig {
  clarity: {
    enabled: boolean;
    configured: boolean;
    projectId: string;
  };
  posthog: {
    enabled: boolean;
    configured: boolean;
    projectKey: string;
    host: string;
    cloudHosts: readonly string[];
    allowedSelfHostedOrigins: readonly string[];
  };
  allowedPaths: readonly string[];
  permanentlyExcludedPrefixes: readonly string[];
  verificationNote: string;
}

export interface UpdateAnalyticsConfigInput {
  clarityEnabled: boolean;
  clarityProjectId: string;
  posthogEnabled: boolean;
  posthogProjectKey: string;
  posthogHost: string;
  allowedSelfHostedOrigins?: readonly string[];
}

export interface AnalyticsService {
  getPublicConfig(): Promise<PublicAnalyticsConfig>;
  getAdminConfig(): Promise<AdminAnalyticsConfig>;
  updateConfig(principal: SessionPrincipal, input: UpdateAnalyticsConfigInput): Promise<AdminAnalyticsConfig>;
  analyticsCsp(pathname: string): Promise<AnalyticsCspPolicy | null>;
}

const ANALYTICS_VERIFICATION_NOTE =
  "Analytics tags are off by default, restricted to /privacy and /terms after explicit in-memory visitor consent, and never exercised against live vendor endpoints in this environment.";

export function createAnalyticsService(deps: ModuleDeps): AnalyticsService {
  async function loadEffectiveState() {
    const [clarityFlag, clarityId, posthogFlag, posthogKey, posthogHost, selfHostedOrigins] = await Promise.all([
      readIntegrationFlag(deps.settings, INTEGRATIONS_CLARITY_FLAG),
      readSetting(deps.settings, INTEGRATIONS_CLARITY_PROJECT_ID),
      readIntegrationFlag(deps.settings, INTEGRATIONS_POSTHOG_FLAG),
      readSetting(deps.settings, INTEGRATIONS_POSTHOG_PROJECT_KEY),
      readSetting(deps.settings, INTEGRATIONS_POSTHOG_HOST),
      readSetting(deps.settings, INTEGRATIONS_POSTHOG_ALLOWED_ORIGINS),
    ]);

    const admittedPostHogOrigins = new Set<string>([
      ...POSTHOG_CLOUD_ORIGINS,
      ...selfHostedOrigins.filter(isSafeAnalyticsOrigin),
    ]);

    const clarityValid = isValidClarityProjectId(clarityId);
    const posthogValid =
      isValidPostHogProjectKey(posthogKey) &&
      isSafeAnalyticsOrigin(posthogHost) &&
      admittedPostHogOrigins.has(posthogHost);

    return {
      clarityFlag,
      clarityId,
      clarityValid,
      clarityActive: clarityFlag && clarityValid,
      posthogFlag,
      posthogKey,
      posthogHost,
      posthogValid,
      posthogActive: posthogFlag && posthogValid,
      selfHostedOrigins,
      admittedPostHogOrigins,
    };
  }

  return {
    async getPublicConfig(): Promise<PublicAnalyticsConfig> {
      const state = await loadEffectiveState();
      return {
        clarity: {
          enabled: state.clarityActive,
          projectId: state.clarityActive ? state.clarityId : null,
        },
        posthog: {
          enabled: state.posthogActive,
          key: state.posthogActive ? state.posthogKey : null,
          host: state.posthogActive ? state.posthogHost : null,
        },
      };
    },

    async getAdminConfig(): Promise<AdminAnalyticsConfig> {
      const state = await loadEffectiveState();
      return {
        clarity: {
          enabled: state.clarityFlag,
          configured: state.clarityValid,
          projectId: state.clarityId,
        },
        posthog: {
          enabled: state.posthogFlag,
          configured: state.posthogValid,
          projectKey: state.posthogKey,
          host: state.posthogHost,
          cloudHosts: POSTHOG_CLOUD_ORIGINS,
          allowedSelfHostedOrigins: state.selfHostedOrigins,
        },
        allowedPaths: ALLOWED_ANALYTICS_PATHS,
        permanentlyExcludedPrefixes: PERMANENTLY_EXCLUDED_ANALYTICS_PREFIXES,
        verificationNote: ANALYTICS_VERIFICATION_NOTE,
      };
    },

    async updateConfig(principal, input): Promise<AdminAnalyticsConfig> {
      const now = deps.clock.now();
      assertIntegrationsManagePreflight(principal, now);

      const clarityProjectId = input.clarityProjectId.trim();
      const posthogProjectKey = input.posthogProjectKey.trim();
      const posthogHost = input.posthogHost.trim();

      if (clarityProjectId !== "" && !isValidClarityProjectId(clarityProjectId)) {
        throw validation(
          "INVALID_CLARITY_PROJECT_ID",
          "Enter a valid alphanumeric Clarity project ID (6–32 characters; scripts and HTML snippets are rejected).",
        );
      }
      if (input.clarityEnabled && !isValidClarityProjectId(clarityProjectId)) {
        throw validation(
          "CLARITY_ID_REQUIRED",
          "Provide a valid Clarity project ID before enabling Microsoft Clarity.",
        );
      }

      if (posthogProjectKey !== "" && !isValidPostHogProjectKey(posthogProjectKey)) {
        throw validation(
          "INVALID_POSTHOG_KEY",
          "Enter a public PostHog project API key beginning with phc_ (personal keys and scripts are rejected).",
        );
      }
      if (!isSafeAnalyticsOrigin(posthogHost)) {
        throw validation(
          "INVALID_POSTHOG_HOST",
          "PostHog host must be an exact HTTPS origin without path, port, IP literal or credentials.",
        );
      }

      let nextSelfHosted: string[] | undefined;
      if (input.allowedSelfHostedOrigins !== undefined) {
        if (input.allowedSelfHostedOrigins.length > 8) {
          throw validation("TOO_MANY_POSTHOG_ORIGINS", "At most 8 self-hosted PostHog origins may be allowlisted.");
        }
        const normalizedOrigins: string[] = [];
        for (const raw of input.allowedSelfHostedOrigins) {
          const trimmed = raw.trim();
          if (!isSafeAnalyticsOrigin(trimmed)) {
            throw validation(
              "INVALID_SELF_HOSTED_POSTHOG_ORIGIN",
              "Every self-hosted PostHog origin must be an exact public HTTPS origin (https://hostname).",
            );
          }
          if (!normalizedOrigins.includes(trimmed) && !(POSTHOG_CLOUD_ORIGINS as readonly string[]).includes(trimmed)) {
            normalizedOrigins.push(trimmed);
          }
        }
        nextSelfHosted = normalizedOrigins;
      }

      await deps.db.transaction(async (tx) => {
        await assertIntegrationsManageInTx(deps, principal, tx);

        const effectiveSelfHosted =
          nextSelfHosted ?? (await readSetting(deps.settings, INTEGRATIONS_POSTHOG_ALLOWED_ORIGINS, tx));
        const admittedOrigins = new Set<string>([...POSTHOG_CLOUD_ORIGINS, ...effectiveSelfHosted]);

        if (!admittedOrigins.has(posthogHost)) {
          throw validation(
            "POSTHOG_ORIGIN_NOT_ALLOWLISTED",
            "PostHog host must be an official PostHog cloud origin or an administrator-allowlisted HTTPS origin.",
          );
        }
        if (input.posthogEnabled && !isValidPostHogProjectKey(posthogProjectKey)) {
          throw validation(
            "POSTHOG_KEY_REQUIRED",
            "Provide a valid PostHog project API key (phc_...) before enabling PostHog.",
          );
        }

        if (nextSelfHosted !== undefined) {
          await writeSetting(deps.settings, INTEGRATIONS_POSTHOG_ALLOWED_ORIGINS, nextSelfHosted, tx);
        }
        await writeSetting(deps.settings, INTEGRATIONS_CLARITY_PROJECT_ID, clarityProjectId, tx);
        await writeSetting(deps.settings, INTEGRATIONS_POSTHOG_PROJECT_KEY, posthogProjectKey, tx);
        await writeSetting(deps.settings, INTEGRATIONS_POSTHOG_HOST, posthogHost, tx);
        await deps.settings.set(flagKey(INTEGRATIONS_CLARITY_FLAG.flag), input.clarityEnabled, tx);
        await deps.settings.set(flagKey(INTEGRATIONS_POSTHOG_FLAG.flag), input.posthogEnabled, tx);

        await deps.audit.record(
          {
            category: "integration",
            eventName: "integration.analytics.updated",
            action: "update",
            outcome: "completed",
            severity: "INFO",
            resource: { type: "integration_provider", publicId: "analytics" },
            attributes: {
              clarity_enabled: input.clarityEnabled,
              clarity_configured: clarityProjectId !== "",
              posthog_enabled: input.posthogEnabled,
              posthog_configured: posthogProjectKey !== "",
              self_hosted_count: effectiveSelfHosted.length,
            },
          },
          tx,
        );
      });

      return this.getAdminConfig();
    },

    async analyticsCsp(pathname: string): Promise<AnalyticsCspPolicy | null> {
      if (!isAllowedAnalyticsPathname(pathname)) {
        return null;
      }
      const state = await loadEffectiveState();
      if (!state.clarityActive && !state.posthogActive) {
        return null;
      }

      const scriptSrc: string[] = [];
      const connectSrc: string[] = [];

      if (state.clarityActive) {
        scriptSrc.push(...CLARITY_SCRIPT_ORIGINS);
        connectSrc.push(...CLARITY_CONNECT_ORIGINS);
      }
      if (state.posthogActive) {
        // Policy-only PostHog uses direct capture fetch — connect-src only, zero external script execution.
        if (!connectSrc.includes(state.posthogHost)) {
          connectSrc.push(state.posthogHost);
        }
      }

      return {
        ...(scriptSrc.length > 0 ? { scriptSrc } : {}),
        ...(connectSrc.length > 0 ? { connectSrc } : {}),
      };
    },
  };
}
