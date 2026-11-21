/**
 * Provider Egress Presets & Cloud-Purpose Policy Constants.
 *
 * Every preset ships disabled by default (zero seeded rows in `integration_egress_allowlist`)
 * until an administrator explicitly enables it with fresh step-up authentication.
 */
import type { Capability } from "../../../shared/capabilities.js";
import { validation } from "../../core/errors.js";
import type { EgressAllowlistRuleView, EgressPurpose } from "./egress.js";

export const EGRESS_PRESET_KEYS = [
  "microsoft_graph",
  "microsoft_graph_upload",
  "entra_oidc",
  "dropbox",
  "google_drive",
  "amazon_s3",
  "wasabi_s3",
  "backblaze_b2",
  "azure_blob",
] as const;
export type EgressPresetKey = (typeof EGRESS_PRESET_KEYS)[number];

export interface EgressPresetParams {
  region?: string;
  bucket?: string;
  accountName?: string;
}

export interface EgressPresetView {
  key: EgressPresetKey;
  label: string;
  purpose: EgressPurpose;
  parameterized: boolean;
  hosts: readonly string[];
  enabled: boolean;
  matchingRulePublicIds: readonly string[];
}

export interface SetEgressPresetInput {
  presetKey: EgressPresetKey;
  enabled: boolean;
  params?: EgressPresetParams;
}

/**
 * Cloud/provider HTTPS purposes that unconditionally enforce `requireAllowlistRule: true`,
 * `publicAddressesOnly: true`, `https:` scheme, and port `443` inside `egress.ts`.
 */
export const MANDATORY_CLOUD_ALLOWLIST_PURPOSES: ReadonlySet<EgressPurpose> = new Set<EgressPurpose>([
  "graph",
  "graph_upload",
  "entra_oidc",
  "storage_s3",
  "storage_azure",
  "storage_dropbox",
  "storage_gdrive",
]);

/**
 * Curated wildcard host suffixes allowed ONLY on `purpose === "graph_upload"` for Microsoft
 * pre-authenticated chunked upload sessions (never broad compute wildcards like `*.amazonaws.com`).
 */
export const GRAPH_UPLOAD_WILDCARD_SUFFIXES = ["sharepoint.com", "files.1drv.com"] as const;

export const FORBIDDEN_UPLOAD_SESSION_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

interface StaticPresetMeta {
  key: EgressPresetKey;
  label: string;
  purpose: EgressPurpose;
  parameterized: boolean;
  fixedHosts: readonly string[];
  justification: string;
  capabilities: readonly Capability[];
}

export const PRESET_CATALOG: readonly StaticPresetMeta[] = [
  {
    key: "microsoft_graph",
    label: "Microsoft Graph & Entra Token",
    purpose: "graph",
    parameterized: false,
    fixedHosts: ["login.microsoftonline.com", "graph.microsoft.com"],
    justification: "Preset: Microsoft Graph v1.0 API and Entra OAuth2 token endpoint",
    capabilities: ["integrations.manage", "mail.manage", "storage.manage"],
  },
  {
    key: "microsoft_graph_upload",
    label: "Microsoft SharePoint & OneDrive Upload Sessions",
    purpose: "graph_upload",
    parameterized: false,
    fixedHosts: ["*.sharepoint.com", "*.files.1drv.com"],
    justification: "Preset: Microsoft Graph chunked upload session endpoints (no bearer)",
    capabilities: ["integrations.manage", "storage.manage"],
  },
  {
    key: "entra_oidc",
    label: "Microsoft Entra ID Single Sign-On (OIDC)",
    purpose: "entra_oidc",
    parameterized: false,
    fixedHosts: ["login.microsoftonline.com"],
    justification: "Preset: Microsoft Entra ID OIDC token and JWKS discovery endpoints",
    capabilities: ["integrations.manage", "identity.sso.manage"],
  },
  {
    key: "dropbox",
    label: "Dropbox API & Content Upload",
    purpose: "storage_dropbox",
    parameterized: false,
    fixedHosts: ["api.dropboxapi.com", "content.dropboxapi.com"],
    justification: "Preset: Dropbox OAuth2 API and content upload endpoints",
    capabilities: ["integrations.manage", "storage.manage"],
  },
  {
    key: "google_drive",
    label: "Google Drive v3 & OAuth2 Token",
    purpose: "storage_gdrive",
    parameterized: false,
    fixedHosts: ["oauth2.googleapis.com", "www.googleapis.com"],
    justification: "Preset: Google OAuth2 token and Google Drive v3 API endpoints",
    capabilities: ["integrations.manage", "storage.manage"],
  },
  {
    key: "amazon_s3",
    label: "Amazon S3 Regional Endpoint",
    purpose: "storage_s3",
    parameterized: true,
    fixedHosts: [],
    justification: "Preset: Amazon S3 regional HTTPS endpoint",
    capabilities: ["integrations.manage", "storage.manage"],
  },
  {
    key: "wasabi_s3",
    label: "Wasabi Hot Cloud Storage Regional Endpoint",
    purpose: "storage_s3",
    parameterized: true,
    fixedHosts: [],
    justification: "Preset: Wasabi S3-compatible regional HTTPS endpoint",
    capabilities: ["integrations.manage", "storage.manage"],
  },
  {
    key: "backblaze_b2",
    label: "Backblaze B2 S3-Compatible Regional Endpoint",
    purpose: "storage_s3",
    parameterized: true,
    fixedHosts: [],
    justification: "Preset: Backblaze B2 S3-compatible regional HTTPS endpoint",
    capabilities: ["integrations.manage", "storage.manage"],
  },
  {
    key: "azure_blob",
    label: "Azure Blob Storage Account Endpoint",
    purpose: "storage_azure",
    parameterized: true,
    fixedHosts: [],
    justification: "Preset: Azure Blob Storage account HTTPS endpoint",
    capabilities: ["integrations.manage", "storage.manage"],
  },
];

const REGION_REGEX = /^[a-z]{2}(?:-[a-z0-9]+){1,4}-[0-9]{1,4}$/;
const S3_VHOST_BUCKET_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const AZURE_ACCOUNT_REGEX = /^[a-z0-9]{3,24}$/;

export function getPresetMeta(key: EgressPresetKey): StaticPresetMeta {
  const found = PRESET_CATALOG.find((item) => item.key === key);
  if (!found) {
    throw validation("INVALID_EGRESS_PRESET", "Select a supported outbound provider preset.");
  }
  return found;
}

export function resolvePresetHosts(key: EgressPresetKey, params?: EgressPresetParams): string[] {
  const meta = getPresetMeta(key);
  if (!meta.parameterized) {
    return [...meta.fixedHosts];
  }

  if (key === "azure_blob") {
    const account = (params?.accountName ?? "").trim().toLowerCase();
    if (!AZURE_ACCOUNT_REGEX.test(account)) {
      throw validation(
        "INVALID_PRESET_AZURE_ACCOUNT",
        "Enter a valid Azure Storage account name (3–24 lowercase letters and digits).",
      );
    }
    return [`${account}.blob.core.windows.net`];
  }

  const region = (params?.region ?? "").trim().toLowerCase();
  if (!REGION_REGEX.test(region)) {
    throw validation("INVALID_PRESET_REGION", "Enter a valid cloud region identifier (for example us-east-1).");
  }
  const bucketRaw = (params?.bucket ?? "").trim().toLowerCase();
  if (bucketRaw !== "" && !S3_VHOST_BUCKET_REGEX.test(bucketRaw) && !/^(?!.*\.\.)(?!\d{1,3}(?:\.\d{1,3}){3}$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketRaw)) {
    throw validation("INVALID_PRESET_BUCKET", "Enter a valid S3 bucket name.");
  }

  let regionalHost: string;
  if (key === "amazon_s3") {
    regionalHost = `s3.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;
  } else if (key === "wasabi_s3") {
    regionalHost = `s3.${region}.wasabisys.com`;
  } else {
    regionalHost = `s3.${region}.backblazeb2.com`;
  }

  const hosts = [regionalHost];
  // Only add virtual-hosted bucket hostname when bucket has no dots (dotted names use path-style on regionalHost).
  if (bucketRaw !== "" && S3_VHOST_BUCKET_REGEX.test(bucketRaw)) {
    hosts.push(`${bucketRaw}.${regionalHost}`);
  }
  return hosts;
}

function ruleMatchesParameterizedPreset(key: EgressPresetKey, pattern: string): boolean {
  if (key === "amazon_s3") {
    return (
      pattern.endsWith(".amazonaws.com") ||
      pattern.endsWith(".amazonaws.com.cn")
    );
  }
  if (key === "wasabi_s3") {
    return pattern.endsWith(".wasabisys.com");
  }
  if (key === "backblaze_b2") {
    return pattern.endsWith(".backblazeb2.com");
  }
  if (key === "azure_blob") {
    return pattern.endsWith(".blob.core.windows.net");
  }
  return false;
}

export function buildPresetView(
  meta: StaticPresetMeta,
  allRules: readonly EgressAllowlistRuleView[],
  concreteHosts?: readonly string[],
): EgressPresetView {
  const purposeRules = allRules.filter(
    (r) => r.purpose === meta.purpose && r.protocol === "https:" && r.port === 443 && r.matchType === "host",
  );

  if (!meta.parameterized) {
    const matched = meta.fixedHosts.map((host) => purposeRules.find((r) => r.pattern === host));
    const allEnabled = matched.length > 0 && matched.every((r) => Boolean(r && r.enabled));
    return {
      key: meta.key,
      label: meta.label,
      purpose: meta.purpose,
      parameterized: false,
      hosts: meta.fixedHosts,
      enabled: allEnabled,
      matchingRulePublicIds: matched.filter((r): r is EgressAllowlistRuleView => Boolean(r)).map((r) => r.publicId),
    };
  }

  if (concreteHosts && concreteHosts.length > 0) {
    const matched = concreteHosts.map((host) => purposeRules.find((r) => r.pattern === host));
    const allEnabled = matched.every((r) => Boolean(r && r.enabled));
    return {
      key: meta.key,
      label: meta.label,
      purpose: meta.purpose,
      parameterized: true,
      hosts: concreteHosts,
      enabled: allEnabled,
      matchingRulePublicIds: matched.filter((r): r is EgressAllowlistRuleView => Boolean(r)).map((r) => r.publicId),
    };
  }

  const matchedAny = purposeRules.filter((r) => ruleMatchesParameterizedPreset(meta.key, r.pattern));
  const enabledRules = matchedAny.filter((r) => r.enabled);
  return {
    key: meta.key,
    label: meta.label,
    purpose: meta.purpose,
    parameterized: true,
    hosts: enabledRules.map((r) => r.pattern),
    enabled: enabledRules.length > 0,
    matchingRulePublicIds: matchedAny.map((r) => r.publicId),
  };
}
