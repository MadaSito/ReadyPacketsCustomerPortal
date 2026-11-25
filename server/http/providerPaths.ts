/** Literal ingress paths. Do not normalize a path before granting a policy exception. */
export const SAML_METADATA_PATH = "/api/identity/saml/metadata";
export const SAML_START_PATH = "/api/identity/saml/start";
export const SAML_ACS_PATH = "/api/identity/saml/acs";
const STRIPE_WEBHOOK_PATH = "/api/payments/webhooks/stripe";

export function isStripeWebhookRequest(method: string, path: string): boolean {
  return method === "POST" && path === STRIPE_WEBHOOK_PATH;
}

export function isSamlRouteFamily(path: string): boolean {
  // Reserve alternate spellings for refusals only, never for dispatch.
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* Compare the literal path. */ }
  return /^\/api\/identity\/saml(?:\/|$)/i.test(decoded);
}
