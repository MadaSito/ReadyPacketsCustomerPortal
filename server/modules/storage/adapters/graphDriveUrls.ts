/**
 * Address parsing and the upload-session URL guard for the Graph drive adapter.
 *
 * Upload-session URLs come from Graph responses and are treated as untrusted and sensitive (they embed a
 * short-lived capability). Accepted only when:
 *   https, port 443 (or default), no userinfo, no fragment, and the host is in the SharePoint host lineage of
 *   the configured tenant: "<t>.sharepoint.com" or "<t>-my.sharepoint.com", where <t> is the tenant name
 *   taken from the drive's own webUrl (which Graph returned for the configured drive id).
 * Everything else is refused before any byte is sent. The URL is never logged.
 */

const SP_SUFFIX = ".sharepoint.com";
const TENANT_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** "contoso" for contoso.sharepoint.com and contoso-my.sharepoint.com; null for anything else. */
export function sharePointTenantOf(hostname: string): string | null {
  const host = hostname.toLowerCase();
  if (!host.endsWith(SP_SUFFIX)) return null;
  let label = host.slice(0, -SP_SUFFIX.length);
  if (label.includes(".")) return null;
  if (label.endsWith("-my")) label = label.slice(0, -3);
  return TENANT_LABEL.test(label) ? label : null;
}

export interface ParsedSiteUrl {
  hostname: string;
  /** Server-relative path without leading/trailing slash, "" for the root site. */
  serverRelativePath: string;
}

/** Parses an administrator-supplied SharePoint site address, e.g. https://contoso.sharepoint.com/sites/Orders. */
export function parseSiteUrl(raw: string): ParsedSiteUrl | null {
  if (raw.length > 400) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  const hostname = url.hostname.toLowerCase();
  const tenant = sharePointTenantOf(hostname);
  // A personal (OneDrive) host is `<tenant>-my`; the host itself was validated by sharePointTenantOf above.
  if (!tenant || hostname.slice(0, -SP_SUFFIX.length).endsWith("-my")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const parts = decoded.split("/").filter(Boolean);
  // Accept the site address itself or any page below it (…/Shared Documents/Forms/AllItems.aspx).
  let siteParts: string[] = [];
  if (parts.length >= 2 && (parts[0]!.toLowerCase() === "sites" || parts[0]!.toLowerCase() === "teams")) siteParts = parts.slice(0, 2);
  else if (parts.length > 0 && !/\.aspx$/i.test(parts[parts.length - 1]!) && parts[0]!.toLowerCase() !== "_layouts") return null;
  if (siteParts.some((p) => p === "." || p === ".." || hasControlOrSeparator(p))) return null;
  return { hostname, serverRelativePath: siteParts.join("/") };
}

function hasControlOrSeparator(value: string): boolean {
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (c <= 0x1f || ch === "\\" || ch === ":") return true;
  }
  return false;
}

/** Graph path for site discovery: /sites/{hostname} or /sites/{hostname}:/{path}. */
export function siteLookupPath(site: ParsedSiteUrl): string {
  if (!site.serverRelativePath) return `/sites/${site.hostname}`;
  return `/sites/${site.hostname}:/${site.serverRelativePath.split("/").map(encodeURIComponent).join("/")}`;
}

/** Validates an upload-session URL against the tenant lineage; returns the URL or null. */
export function checkUploadUrl(raw: unknown, tenant: string): URL | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
  if (url.port && url.port !== "443") return null;
  const hostTenant = sharePointTenantOf(url.hostname);
  return hostTenant !== null && hostTenant === tenant ? url : null;
}

/** One path segment as given by a caller (folder label or file name): non-empty, no separators, no dot names. */
export function isValidSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment.length <= 255 &&
    segment === segment.normalize("NFC") &&
    segment.trim() === segment &&
    segment !== "." &&
    segment !== ".." &&
    !segment.endsWith(".") &&
    !/[\p{Cc}\p{Cf}"*:<>?/\\|]/u.test(segment)
  );
}

/** "/a/b" relative path encoded for a Graph `root:/…:` address. */
export function encodeDrivePath(segments: readonly string[]): string {
  return segments.map((s) => encodeURIComponent(s)).join("/");
}

/** Splits the configured root folder path ("A/B") into validated segments; null when invalid. */
export function splitRootFolderPath(raw: string): string[] | null {
  const parts = raw.split("/").map((p) => p.trim()).filter(Boolean);
  return parts.every(isValidSegment) ? parts : null;
}
