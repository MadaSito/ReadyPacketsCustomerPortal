import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainError } from "../../../core/errors.js";
import type { EgressFetchOptions, EgressFetchResponse, EgressPolicy, EgressPurpose } from "../../integrations/egress.js";

export const oauthProviders = ["dropbox", "google_drive"] as const;
export type StorageOAuthProvider = (typeof oauthProviders)[number];
export type OAuthApp = { clientId: string; clientSecret: string };
export type OAuthGrant = { accessToken: string; refreshToken?: string; expiresIn: number };
export type StorageRequest = (url: string | URL, options?: EgressFetchOptions) => Promise<EgressFetchResponse>;

const DROPBOX_SCOPE = "files.metadata.read files.content.write";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const endpoints = {
  dropbox: { authorize: "https://www.dropbox.com/oauth2/authorize", token: "https://api.dropboxapi.com/oauth2/token" },
  google_drive: { authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token" },
} as const;

const token = z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/);
const grantSchema = z.object({
  token_type: z.string().max(20).transform((s) => s.toLowerCase()).pipe(z.literal("bearer")),
  access_token: token,
  refresh_token: token.optional(),
  expires_in: z.number().int().min(1).max(86_400),
  scope: z.string().max(4096).optional(),
});

export function storageProviderError(status?: number): DomainError {
  if (status === 429) return new DomainError("RATE_LIMITED", "STORAGE_PROVIDER_RATE_LIMITED", "The storage provider is throttling requests.");
  if (status === 400 || status === 401 || status === 403) {
    return new DomainError("VALIDATION", "STORAGE_OAUTH_AUTHORIZATION_REJECTED", "The storage provider refused the authorization. Check the app registration or reconnect the account.");
  }
  return new DomainError("UNAVAILABLE", "STORAGE_PROVIDER_UNAVAILABLE", "The storage provider could not complete the request.");
}

/** Fixed provider inputs are checked again by the central HTTPS egress policy on every request. */
export function providerRequest(egress: EgressPolicy, purpose: EgressPurpose): StorageRequest {
  return (url, options = {}) => egress.fetchPinned(url, purpose, {
    timeoutMs: 15_000, maxResponseBytes: 65_536, ...options, requireAllowlistRule: true, publicAddressesOnly: true,
  });
}

export function authorizationUrl(provider: StorageOAuthProvider, redirectUri: string, clientId: string, state: string, verifier: string): string {
  const url = new URL(endpoints[provider].authorize);
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", state,
    code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    ...(provider === "dropbox" ? { token_access_type: "offline", scope: DROPBOX_SCOPE } :
      { access_type: "offline", prompt: "consent", scope: DRIVE_SCOPE }),
  }).toString();
  return url.href;
}

function form(parameters: Record<string, string>, signal?: AbortSignal): EgressFetchOptions {
  const body = new URLSearchParams(parameters).toString();
  return { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(Buffer.byteLength(body)) }, body, signal };
}

function grantedScopes(provider: StorageOAuthProvider, scope: string): boolean {
  const requested = (provider === "dropbox" ? DROPBOX_SCOPE : DRIVE_SCOPE).split(" ");
  const granted = new Set(scope.split(/\s+/));
  return requested.every((value) => granted.has(value));
}

async function requestGrant(
  request: StorageRequest, provider: StorageOAuthProvider, app: OAuthApp, parameters: Record<string, string>, signal?: AbortSignal,
): Promise<OAuthGrant> {
  const rsp = await request(endpoints[provider].token, form({ client_id: app.clientId, client_secret: app.clientSecret, ...parameters }, signal));
  if (rsp.status !== 200) throw storageProviderError(rsp.status);
  let payload: unknown;
  try { payload = JSON.parse(rsp.body.toString("utf8")); } catch { throw storageProviderError(); }
  const parsed = grantSchema.safeParse(payload);
  if (!parsed.success) throw storageProviderError();
  const data = parsed.data;
  if (data.scope !== undefined && !grantedScopes(provider, data.scope)) throw storageProviderError(403);
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

export async function exchangeCode(
  request: StorageRequest, provider: StorageOAuthProvider, app: OAuthApp,
  input: { code: string; verifier: string; redirectUri: string }, signal?: AbortSignal,
): Promise<OAuthGrant & { refreshToken: string }> {
  const grant = await requestGrant(request, provider, app, {
    grant_type: "authorization_code", code: input.code, code_verifier: input.verifier, redirect_uri: input.redirectUri,
  }, signal);
  if (!grant.refreshToken) {
    throw new DomainError("VALIDATION", "STORAGE_OAUTH_NO_REFRESH_TOKEN", "The storage provider did not grant offline access. Reconnect and approve offline access.");
  }
  return { ...grant, refreshToken: grant.refreshToken };
}

export function refreshAccess(
  request: StorageRequest, provider: StorageOAuthProvider, app: OAuthApp, refreshToken: string, signal?: AbortSignal,
): Promise<OAuthGrant> {
  return requestGrant(request, provider, app, { grant_type: "refresh_token", refresh_token: refreshToken }, signal);
}

/** Provider acknowledgement is required before reporting successful remote revocation. */
export async function revokeGrant(
  request: StorageRequest, provider: StorageOAuthProvider, app: OAuthApp, refreshToken: string, signal?: AbortSignal,
): Promise<void> {
  if (provider === "google_drive") {
    const rsp = await request("https://oauth2.googleapis.com/revoke", form({ token: refreshToken }, signal));
    if (rsp.status !== 200) throw storageProviderError(rsp.status);
    return;
  }
  // Dropbox revokes the associated refresh grant through a bearer access token, not in the URL.
  const grant = await refreshAccess(request, provider, app, refreshToken, signal);
  const rsp = await request("https://api.dropboxapi.com/2/auth/token/revoke", {
    method: "POST", headers: { Authorization: `Bearer ${grant.accessToken}`, "Content-Length": "0" }, signal,
  });
  if (rsp.status !== 200 && rsp.status !== 204) throw storageProviderError(rsp.status);
}
