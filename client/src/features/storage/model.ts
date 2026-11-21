/**
 * Client-side domain types, 9-provider catalog, validation rules, and state badge
 * helpers for Storage connections (/admin/storage, /admin/storage/new,
 * /admin/storage/:publicId/edit) and SharePoint order sync (/admin/sharepoint-sync).
 *
 * All validation rules mirror server/modules/storage/adapters/*.ts,
 * server/modules/storage/oauth/http.ts, and server/modules/sharepoint/router.ts.
 */
import type { Tone } from "@/ui";

export type StorageProviderKind =
  | "s3"
  | "azure_blob"
  | "dropbox"
  | "google_drive"
  | "sharepoint"
  | "onedrive";

export type S3Preset = "aws" | "wasabi" | "backblaze" | "custom";

export type ProviderChoiceId =
  | "aws_s3"
  | "wasabi"
  | "backblaze_b2"
  | "custom_s3"
  | "azure_blob"
  | "dropbox"
  | "google_drive"
  | "sharepoint"
  | "onedrive";

export type StoragePurpose = "order_files" | "backups" | "order_data";

export type StorageTestCode =
  | "OK"
  | "NOT_CONFIGURED"
  | "AUTH_FAILED"
  | "DESTINATION_NOT_FOUND"
  | "DESTINATION_DENIED"
  | "EGRESS_DENIED"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE";

export interface StorageTestResult {
  ok: boolean;
  code: StorageTestCode;
}

export type StorageConfig = Record<string, string | number | boolean>;
export type StorageCredentials = Record<string, string>;

export interface StorageConnectionView {
  publicId: string;
  kind: StorageProviderKind;
  name: string;
  config: StorageConfig;
  credentialsConfigured: boolean;
  oauthConnected: boolean;
  enabled: boolean;
  version: number;
  lastTest: (StorageTestResult & { checkedAt: Date | string }) | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface StorageAssignmentView {
  purpose: StoragePurpose;
  connectionPublicId: string;
}

export type EgressPresetKey =
  | "microsoft_graph"
  | "microsoft_graph_upload"
  | "entra_oidc"
  | "dropbox"
  | "google_drive"
  | "amazon_s3"
  | "wasabi_s3"
  | "backblaze_b2"
  | "azure_blob";

export interface EgressPresetStatus {
  presetKey: EgressPresetKey;
  title: string;
  description: string;
  hosts: string[];
  requiredParams: ("region" | "bucket" | "accountName")[];
  enabled: boolean;
  activeHosts: string[];
}

export interface ProviderChoiceOption {
  id: ProviderChoiceId;
  kind: StorageProviderKind;
  s3Preset?: S3Preset;
  label: string;
  description: string;
  supportedPurposes: readonly StoragePurpose[];
  egressPresets: readonly EgressPresetKey[];
  usesOAuth: boolean;
  usesDiscovery: boolean;
}

export const PROVIDER_CHOICES: readonly ProviderChoiceOption[] = [
  {
    id: "aws_s3",
    kind: "s3",
    s3Preset: "aws",
    label: "Amazon S3",
    description: "AWS S3 bucket authenticated with IAM Access key ID and Secret access key.",
    supportedPurposes: ["order_files", "backups"],
    egressPresets: ["amazon_s3"],
    usesOAuth: false,
    usesDiscovery: false,
  },
  {
    id: "wasabi",
    kind: "s3",
    s3Preset: "wasabi",
    label: "Wasabi",
    description: "Wasabi Hot Cloud Storage bucket using regional s3.<region>.wasabisys.com endpoints.",
    supportedPurposes: ["order_files", "backups"],
    egressPresets: ["wasabi_s3"],
    usesOAuth: false,
    usesDiscovery: false,
  },
  {
    id: "backblaze_b2",
    kind: "s3",
    s3Preset: "backblaze",
    label: "Backblaze B2",
    description: "Backblaze B2 S3-compatible bucket using Application key ID and Application key.",
    supportedPurposes: ["order_files", "backups"],
    egressPresets: ["backblaze_b2"],
    usesOAuth: false,
    usesDiscovery: false,
  },
  {
    id: "custom_s3",
    kind: "s3",
    s3Preset: "custom",
    label: "Custom S3-compatible",
    description: "Self-hosted or regional S3-compatible object store over HTTPS (port 443, path-style).",
    supportedPurposes: ["order_files", "backups"],
    egressPresets: [],
    usesOAuth: false,
    usesDiscovery: false,
  },
  {
    id: "azure_blob",
    kind: "azure_blob",
    label: "Azure Blob Storage",
    description: "Azure Storage account container authenticated with Shared Key or container HTTPS SAS token.",
    supportedPurposes: ["order_files", "backups"],
    egressPresets: ["azure_blob"],
    usesOAuth: false,
    usesDiscovery: false,
  },
  {
    id: "dropbox",
    kind: "dropbox",
    label: "Dropbox",
    description: "Dropbox folder authorized with your own Dropbox App key, App secret, and OAuth 2.0 PKCE.",
    supportedPurposes: ["order_files"],
    egressPresets: ["dropbox"],
    usesOAuth: true,
    usesDiscovery: false,
  },
  {
    id: "google_drive",
    kind: "google_drive",
    label: "Google Drive",
    description: "Google Drive folder authorized with your own Google OAuth Client ID, Client secret, and PKCE.",
    supportedPurposes: ["order_files"],
    egressPresets: ["google_drive"],
    usesOAuth: true,
    usesDiscovery: false,
  },
  {
    id: "sharepoint",
    kind: "sharepoint",
    label: "SharePoint library",
    description: "Microsoft 365 SharePoint document library (and optional SharePoint order-data list sync).",
    supportedPurposes: ["order_files", "order_data"],
    egressPresets: ["microsoft_graph", "microsoft_graph_upload"],
    usesOAuth: false,
    usesDiscovery: true,
  },
  {
    id: "onedrive",
    kind: "onedrive",
    label: "OneDrive for Business",
    description: "Dedicated Microsoft 365 OneDrive for Business account accessed via single-tenant Entra app.",
    supportedPurposes: ["order_files"],
    egressPresets: ["microsoft_graph", "microsoft_graph_upload"],
    usesOAuth: false,
    usesDiscovery: true,
  },
] as const;

export function resolveProviderChoice(
  kind: StorageProviderKind,
  config?: StorageConfig,
): ProviderChoiceOption {
  if (kind === "s3") {
    const preset = typeof config?.preset === "string" ? config.preset : "aws";
    if (preset === "wasabi") return PROVIDER_CHOICES[1]!;
    if (preset === "backblaze") return PROVIDER_CHOICES[2]!;
    if (preset === "custom") return PROVIDER_CHOICES[3]!;
    return PROVIDER_CHOICES[0]!;
  }
  return PROVIDER_CHOICES.find((c) => c.kind === kind) ?? PROVIDER_CHOICES[0]!;
}

export const PURPOSE_META: Record<
  StoragePurpose,
  { label: string; description: string; maxConnections: number }
> = {
  order_files: {
    label: "Order files",
    description: "Asynchronous secondary copies of customer and fulfillment order files (up to 8 enabled connections).",
    maxConnections: 8,
  },
  backups: {
    label: "Off-site backups",
    description: "Encrypted off-site copies of verified backup archives for 3-2-1 resilience (object storage only, up to 8).",
    maxConnections: 8,
  },
  order_data: {
    label: "SharePoint order data",
    description: "Single SharePoint site connection used to mirror structured order rows into a SharePoint list.",
    maxConnections: 1,
  },
};

export const STORAGE_TEST_CODE_LABELS: Record<StorageTestCode, string> = {
  OK: "Connection verified",
  NOT_CONFIGURED: "Credentials or discovery incomplete",
  AUTH_FAILED: "Authentication rejected by provider",
  DESTINATION_NOT_FOUND: "Bucket, container, drive, or folder not found",
  DESTINATION_DENIED: "Access denied to target destination",
  EGRESS_DENIED: "Blocked by outbound allowlist — enable the provider egress preset",
  RATE_LIMITED: "Provider rate-limited the check — wait and retry",
  PROVIDER_UNAVAILABLE: "Provider unreachable or returned a transient error",
};

export interface ConnectionStatusPresentation {
  label: string;
  tone: Tone;
  canEnable: boolean;
}

export function describeConnectionStatus(conn: StorageConnectionView): ConnectionStatusPresentation {
  if (conn.enabled) {
    return { label: "Enabled", tone: "success", canEnable: false };
  }
  const choice = resolveProviderChoice(conn.kind, conn.config);
  if (!conn.credentialsConfigured) {
    return { label: "Credentials required", tone: "neutral", canEnable: false };
  }
  if (choice.usesOAuth && !conn.oauthConnected) {
    return { label: "Awaiting OAuth consent", tone: "warning", canEnable: false };
  }
  if (choice.usesDiscovery) {
    const driveId = typeof conn.config.driveId === "string" ? conn.config.driveId : "";
    const siteOk = conn.kind === "onedrive" || Boolean(conn.config.siteId);
    if (!siteOk || !driveId) {
      return { label: "Library discovery required", tone: "warning", canEnable: false };
    }
  }
  if (!conn.lastTest) {
    return { label: "Test required", tone: "info", canEnable: false };
  }
  if (!conn.lastTest.ok) {
    return { label: "Test failed", tone: "danger", canEnable: false };
  }
  return { label: "Tested — ready to enable", tone: "success", canEnable: true };
}

// ---------------------------------------------------------------------------
// SharePoint discovery & order-data sync types
// ---------------------------------------------------------------------------

export type SharePointSyncRowState = "pending" | "synced" | "failed";

export type OrderSyncTestCode =
  | "OK"
  | "NOT_CONFIGURED"
  | "LIST_NOT_FOUND"
  | "LIST_INCOMPATIBLE"
  | "AUTH_FAILED"
  | "DESTINATION_DENIED"
  | "EGRESS_DENIED"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE";

export const ORDER_SYNC_TEST_CODE_LABELS: Record<OrderSyncTestCode, string> = {
  OK: "SharePoint list verified and compatible",
  NOT_CONFIGURED: "Assign a SharePoint connection and select a list first",
  LIST_NOT_FOUND: "Selected SharePoint list was not found on the site",
  LIST_INCOMPATIBLE: "Selected list is missing required ReadyPackets columns",
  AUTH_FAILED: "Microsoft Graph authentication failed",
  DESTINATION_DENIED: "App lacks permission to read/write items in the SharePoint list",
  EGRESS_DENIED: "Microsoft Graph outbound allowlist preset is disabled",
  RATE_LIMITED: "Microsoft Graph rate-limited the request — retry shortly",
  PROVIDER_UNAVAILABLE: "SharePoint or Microsoft Graph is temporarily unavailable",
};

export interface OrderSyncBackfillStatus {
  state: "running" | "completed" | "failed";
  enqueued: number;
  reasonCode: string | null;
  startedAt: Date | string;
  finishedAt: Date | string | null;
}

export interface OrderSyncSettingsView {
  enabled: boolean;
  connectionPublicId: string | null;
  siteId: string | null;
  siteLabel: string | null;
  listId: string | null;
  listLabel: string | null;
  includePortalLink: boolean;
  version: number;
  state: "disabled" | "not_configured" | "ready" | "error";
  lastError: { reasonCode: string; at: Date | string } | null;
  counts: { pending: number; synced: number; failed: number };
  backfill?: OrderSyncBackfillStatus | null;
}

export interface SharePointDiscoveredSite {
  siteId: string;
  displayName: string;
  webUrl: string;
}

export interface SharePointDriveItem {
  driveId: string;
  name: string;
  driveType: "documentLibrary";
}

export interface SharePointFolderItem {
  itemId: string;
  name: string;
  path: string;
}

export interface SharePointListSummary {
  listId: string;
  displayName: string;
  compatible: boolean;
}

export interface OrderSyncStatusRow {
  orderPublicId: string;
  reference: string | null;
  state: SharePointSyncRowState;
  attempts: number;
  lastSyncedAt: Date | string | null;
  reasonCode: string | null;
}

// ---------------------------------------------------------------------------
// Provider form draft & validation
// ---------------------------------------------------------------------------

export interface WizardFormDraft {
  choiceId: ProviderChoiceId;
  name: string;
  // S3
  s3Bucket: string;
  s3Region: string;
  s3Prefix: string;
  s3Endpoint: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3SessionToken: string;
  // Azure Blob
  azureAccount: string;
  azureContainer: string;
  azurePrefix: string;
  azureAuth: "shared_key" | "sas";
  azureAccountKey: string;
  azureSasToken: string;
  // Dropbox / Google Drive
  oauthClientId: string;
  oauthClientSecret: string;
  oauthRootPath: string;
  // SharePoint / OneDrive
  graphTenantId: string;
  graphClientId: string;
  graphClientSecret: string;
  sharepointSiteUrl: string;
  sharepointSiteId: string;
  onedriveUpn: string;
  graphDriveId: string;
  graphDriveName: string;
  graphRootFolderPath: string;
  // Credential clear checkbox when editing
  clearCredentials: boolean;
}

export function createEmptyWizardDraft(choiceId: ProviderChoiceId = "aws_s3"): WizardFormDraft {
  return {
    choiceId,
    name: "",
    s3Bucket: "",
    s3Region: "",
    s3Prefix: "",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    s3SessionToken: "",
    azureAccount: "",
    azureContainer: "",
    azurePrefix: "",
    azureAuth: "shared_key",
    azureAccountKey: "",
    azureSasToken: "",
    oauthClientId: "",
    oauthClientSecret: "",
    oauthRootPath: choiceId === "google_drive" ? "ReadyPackets" : "",
    graphTenantId: "",
    graphClientId: "",
    graphClientSecret: "",
    sharepointSiteUrl: "",
    sharepointSiteId: "",
    onedriveUpn: "",
    graphDriveId: "",
    graphDriveName: "",
    graphRootFolderPath: "",
    clearCredentials: false,
  };
}

export function draftFromConnection(conn: StorageConnectionView): WizardFormDraft {
  const choice = resolveProviderChoice(conn.kind, conn.config);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    ...createEmptyWizardDraft(choice.id),
    name: conn.name,
    s3Bucket: str(conn.config.bucket),
    s3Region: str(conn.config.region),
    s3Prefix: str(conn.config.prefix),
    s3Endpoint: str(conn.config.endpoint),
    azureAccount: str(conn.config.account),
    azureContainer: str(conn.config.container),
    azurePrefix: str(conn.config.prefix),
    azureAuth: conn.config.auth === "sas" ? "sas" : "shared_key",
    oauthClientId: str(conn.config.clientId),
    oauthRootPath: str(conn.config.rootPath),
    graphTenantId: str(conn.config.tenantId),
    graphClientId: str(conn.config.clientId),
    sharepointSiteUrl: str(conn.config.siteUrl),
    sharepointSiteId: str(conn.config.siteId),
    onedriveUpn: str(conn.config.userPrincipalName),
    graphDriveId: str(conn.config.driveId),
    graphDriveName: str(conn.config.driveName),
    graphRootFolderPath: str(conn.config.rootFolderPath),
  };
}

const BUCKET_RE = /^(?!.*\.\.)(?!\d{1,3}(?:\.\d{1,3}){3}$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const STANDARD_REGION_RE = /^[a-z]{2}(?:-[a-z0-9]+){1,4}-[0-9]{1,4}$/;
const CUSTOM_REGION_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const AZURE_ACCOUNT_RE = /^[a-z0-9]{3,24}$/;
const AZURE_CONTAINER_RE = /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const AZURE_KEY_RE = /^[A-Za-z0-9+/]{86}==$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildConfigFromDraft(draft: WizardFormDraft): StorageConfig {
  const choice = PROVIDER_CHOICES.find((c) => c.id === draft.choiceId) ?? PROVIDER_CHOICES[0]!;
  switch (choice.kind) {
    case "s3": {
      const preset = choice.s3Preset ?? "aws";
      const cfg: StorageConfig = {
        preset,
        bucket: draft.s3Bucket.trim(),
        region: draft.s3Region.trim(),
      };
      if (draft.s3Prefix.trim()) cfg.prefix = draft.s3Prefix.trim().replace(/^\/+|\/+$/g, "");
      if (preset === "custom" && draft.s3Endpoint.trim()) cfg.endpoint = draft.s3Endpoint.trim();
      return cfg;
    }
    case "azure_blob": {
      const cfg: StorageConfig = {
        account: draft.azureAccount.trim(),
        container: draft.azureContainer.trim(),
        auth: draft.azureAuth,
      };
      if (draft.azurePrefix.trim()) cfg.prefix = draft.azurePrefix.trim().replace(/^\/+|\/+$/g, "");
      return cfg;
    }
    case "dropbox":
    case "google_drive": {
      const cfg: StorageConfig = {
        clientId: draft.oauthClientId.trim(),
      };
      const cleanedPath = draft.oauthRootPath.trim().replace(/^\/+|\/+$/g, "");
      if (cleanedPath) cfg.rootPath = cleanedPath;
      return cfg;
    }
    case "sharepoint":
      return {
        tenantId: draft.graphTenantId.trim(),
        clientId: draft.graphClientId.trim(),
        siteUrl: draft.sharepointSiteUrl.trim(),
        siteId: draft.sharepointSiteId.trim(),
        driveId: draft.graphDriveId.trim(),
        driveName: draft.graphDriveName.trim(),
        rootFolderPath: draft.graphRootFolderPath.trim().replace(/^\/+|\/+$/g, ""),
      };
    case "onedrive":
      return {
        tenantId: draft.graphTenantId.trim(),
        clientId: draft.graphClientId.trim(),
        userPrincipalName: draft.onedriveUpn.trim(),
        driveId: draft.graphDriveId.trim(),
        driveName: draft.graphDriveName.trim(),
        rootFolderPath: draft.graphRootFolderPath.trim().replace(/^\/+|\/+$/g, ""),
      };
  }
}

export function buildCredentialsFromDraft(
  draft: WizardFormDraft,
): StorageCredentials | null | undefined {
  if (draft.clearCredentials) return null;
  const choice = PROVIDER_CHOICES.find((c) => c.id === draft.choiceId) ?? PROVIDER_CHOICES[0]!;
  switch (choice.kind) {
    case "s3": {
      const accessKeyId = draft.s3AccessKeyId.trim();
      const secretAccessKey = draft.s3SecretAccessKey.trim();
      const sessionToken = draft.s3SessionToken.trim();
      if (!accessKeyId && !secretAccessKey && !sessionToken) return undefined;
      return {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken ? { sessionToken } : {}),
      };
    }
    case "azure_blob": {
      if (draft.azureAuth === "shared_key") {
        const accountKey = draft.azureAccountKey.trim();
        return accountKey ? { accountKey } : undefined;
      }
      const sasToken = draft.azureSasToken.trim().replace(/^\?/, "");
      return sasToken ? { sasToken } : undefined;
    }
    case "dropbox":
    case "google_drive": {
      const clientSecret = draft.oauthClientSecret.trim();
      return clientSecret ? { clientSecret } : undefined;
    }
    case "sharepoint":
    case "onedrive": {
      const clientSecret = draft.graphClientSecret.trim();
      return clientSecret ? { clientSecret } : undefined;
    }
  }
}

export function configsEqual(a: StorageConfig, b: StorageConfig): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k, idx) => k === bKeys[idx] && a[k] === b[k]);
}

export function validateWizardStep2(
  draft: WizardFormDraft,
  existing: StorageConnectionView | null,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const choice = PROVIDER_CHOICES.find((c) => c.id === draft.choiceId) ?? PROVIDER_CHOICES[0]!;

  if (!draft.name.trim()) {
    errors.name = "Enter a connection display name.";
  } else if (draft.name.trim().length > 120) {
    errors.name = "Display name must be 120 characters or fewer.";
  }

  const nextConfig = buildConfigFromDraft(draft);
  const configChanged = existing ? !configsEqual(existing.config, nextConfig) : true;
  const creds = buildCredentialsFromDraft(draft);
  const needsCredentials = !existing || !existing.credentialsConfigured || (configChanged && !draft.clearCredentials);

  if (existing && configChanged && existing.oauthConnected) {
    errors.rebind =
      "Disconnect the active OAuth grant on the Storage connections list before changing destination or client settings.";
  }

  if (choice.kind === "s3") {
    const preset = choice.s3Preset ?? "aws";
    if (!BUCKET_RE.test(draft.s3Bucket.trim())) {
      errors.s3Bucket = "Enter a valid lowercase S3 bucket name (3–63 characters).";
    }
    const regionRe = preset === "custom" ? CUSTOM_REGION_RE : STANDARD_REGION_RE;
    if (!regionRe.test(draft.s3Region.trim())) {
      errors.s3Region =
        preset === "custom"
          ? "Enter a lowercase region identifier (for example us-east-1)."
          : "Enter a standard cloud region code (for example us-east-1 or eu-central-1).";
    }
    if (preset === "custom") {
      try {
        const u = new URL(draft.s3Endpoint.trim());
        if (
          u.protocol !== "https:" ||
          Boolean(u.username || u.password) ||
          (u.port !== "" && u.port !== "443") ||
          u.pathname !== "/" ||
          Boolean(u.search || u.hash)
        ) {
          errors.s3Endpoint = "Enter a root https:// hostname URL without path, query, or credentials.";
        }
      } catch {
        errors.s3Endpoint = "Enter a valid https:// endpoint URL (for example https://s3.storage.example.com).";
      }
    }
    if (needsCredentials && !draft.clearCredentials) {
      if (draft.s3AccessKeyId.trim().length < 12) {
        errors.s3AccessKeyId = existing?.credentialsConfigured
          ? "Re-enter the Access key ID when changing bucket, region, or endpoint settings."
          : "Enter the Access key ID (at least 12 characters).";
      }
      if (draft.s3SecretAccessKey.trim().length < 16) {
        errors.s3SecretAccessKey = "Enter the Secret access key (at least 16 characters).";
      }
    }
  } else if (choice.kind === "azure_blob") {
    if (!AZURE_ACCOUNT_RE.test(draft.azureAccount.trim())) {
      errors.azureAccount = "Storage account name must be 3–24 lowercase letters and digits.";
    }
    if (!AZURE_CONTAINER_RE.test(draft.azureContainer.trim())) {
      errors.azureContainer = "Container name must be 3–63 lowercase letters, digits, and single hyphens.";
    }
    if (needsCredentials && !draft.clearCredentials) {
      if (draft.azureAuth === "shared_key") {
        if (!AZURE_KEY_RE.test(draft.azureAccountKey.trim())) {
          errors.azureAccountKey = "Enter the 88-character base64 Azure Storage account key (ending in ==).";
        }
      } else {
        const raw = draft.azureSasToken.trim().replace(/^\?/, "");
        const params = new URLSearchParams(raw);
        if (
          !raw ||
          params.get("sr") !== "c" ||
          params.get("spr") !== "https" ||
          !params.get("sv") ||
          !params.get("sig")
        ) {
          errors.azureSasToken =
            "Enter a container-scoped HTTPS SAS token (must include sr=c, spr=https, sv, and sig).";
        }
      }
    }
  } else if (choice.kind === "dropbox" || choice.kind === "google_drive") {
    if (draft.oauthClientId.trim().length < 4) {
      errors.oauthClientId =
        choice.kind === "dropbox" ? "Enter your Dropbox App key." : "Enter your Google OAuth Client ID.";
    }
    if (needsCredentials && !draft.clearCredentials && creds === undefined) {
      errors.oauthClientSecret =
        choice.kind === "dropbox"
          ? "Enter your Dropbox App secret."
          : "Enter your Google OAuth Client secret.";
    } else if (creds && (creds.clientSecret ?? "").length < 8) {
      errors.oauthClientSecret = "Secret must be at least 8 characters.";
    }
  } else if (choice.kind === "sharepoint" || choice.kind === "onedrive") {
    const tenant = draft.graphTenantId.trim();
    if (["common", "organizations", "consumers"].includes(tenant.toLowerCase()) || !GUID_RE.test(tenant)) {
      errors.graphTenantId = "Enter a single-tenant Entra Directory (tenant) ID GUID.";
    }
    if (!GUID_RE.test(draft.graphClientId.trim())) {
      errors.graphClientId = "Enter the Entra Application (client) ID GUID.";
    }
    if (choice.kind === "sharepoint") {
      try {
        const u = new URL(draft.sharepointSiteUrl.trim());
        if (u.protocol !== "https:" || !u.hostname.endsWith(".sharepoint.com")) {
          errors.sharepointSiteUrl = "Enter an https://<tenant>.sharepoint.com/sites/<name> URL.";
        }
      } catch {
        errors.sharepointSiteUrl = "Enter a valid https://<tenant>.sharepoint.com site URL.";
      }
    } else {
      const upn = draft.onedriveUpn.trim();
      if (!upn || !upn.includes("@") || upn.length > 254) {
        errors.onedriveUpn = "Enter the dedicated account UPN (e-mail address).";
      }
    }
    if (needsCredentials && !draft.clearCredentials && creds === undefined) {
      errors.graphClientSecret = "Enter the Entra Client secret.";
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// OAuth fragment handle parser (two-step Strict-cookie proof flow)
// ---------------------------------------------------------------------------

const OAUTH_HANDLE_RE = /^[A-Za-z0-9_-]{43}$/;

export function parseOAuthAttemptHandle(hash: string): string | null {
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!trimmed) return null;
  const params = new URLSearchParams(trimmed);
  const candidate = params.get("oauth-attempt");
  if (!candidate || !OAUTH_HANDLE_RE.test(candidate)) return null;
  return candidate;
}
