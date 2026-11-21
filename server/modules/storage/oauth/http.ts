import type { Request, Response, Router } from "express";
import { z } from "zod";
import type { Services } from "../../../container.js";
import { DomainError, validation } from "../../../core/errors.js";
import { getHttpState, requireHttpCapability } from "../../../http/requestState.js";
import { readCookie } from "../../../http/sessionTransport.js";
import { rateLimitAddress } from "../../../security/rateLimitAddress.js";
import { oauthProviders } from "./provider.js";
import { requestForOAuthProvider } from "./register.js";
import { OAUTH_TTL_MS, opaqueSecret, storageOAuthService, storageRedirectUri } from "./service.js";

const providerSchema = z.enum(oauthProviders);
const targetSchema = z.strictObject({
  provider: providerSchema,
  publicId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  expectedVersion: z.number().int().min(1).max(4_294_967_295),
});
const cookieOptions = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;
const cookieName = (state: string) => `__Host-rp_storage_oauth_${state.slice(0, 22)}`;

function privateResponse(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
}

export function registerStorageOAuthRoutes(router: Router, services: Services): void {
  const oauth = storageOAuthService(services, (provider) => requestForOAuthProvider(services, provider));
  const admin = (req: Request) => requireHttpCapability(req, "storage.manage", services.clock.now());
  async function budget(key: string): Promise<void> {
    const limit = await services.rateLimiter.consume("auth_high_risk", `storage_oauth:${key}`);
    if (!limit.allowed) throw new DomainError("RATE_LIMITED", "RATE_LIMITED",
      "Too many requests. Please wait and try again.", { retryAfterSeconds: limit.retryAfterSeconds });
  }
  function target(req: Request) {
    const parsed = targetSchema.safeParse(req.body);
    if (!parsed.success) throw validation("STORAGE_OAUTH_INPUT_INVALID", "Choose a valid storage connection.");
    return parsed.data;
  }
  router.get("/storage/oauth/redirect-uri/:provider", (req, res) => {
    privateResponse(res);
    admin(req);
    const provider = providerSchema.safeParse(req.params.provider);
    if (!provider.success) throw validation("STORAGE_OAUTH_INPUT_INVALID", "Choose a supported storage provider.");
    res.json({ redirectUri: storageRedirectUri(services, provider.data) });
  });
  router.post("/storage/oauth/start", async (req, res) => {
    privateResponse(res);
    const actor = admin(req);
    await budget(`admin:${actor.userId}`);
    const { authorizeUrl, binder } = await oauth.start(actor, target(req));
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    res.cookie(cookieName(state), binder, { ...cookieOptions, maxAge: OAUTH_TTL_MS });
    res.json({ authorizeUrl });
  });
  router.post("/storage/oauth/disconnect", async (req, res) => {
    privateResponse(res);
    const actor = admin(req);
    await budget(`admin:${actor.userId}`);
    res.json(await oauth.disconnect(actor, target(req)));
  });
  router.get("/storage/oauth/callback/:provider", async (req, res) => {
    privateResponse(res);
    // Express GET routes also match HEAD. A preflight/probe must never consume one-time state.
    if (req.method !== "GET") { res.status(405).setHeader("Allow", "GET").end(); return; }
    const { context, session } = getHttpState(req);
    await budget(`ip:${rateLimitAddress(context.ipAddress)}`);
    const provider = providerSchema.safeParse(req.params.provider);
    const { state, code, error } = req.query;
    let outcome = "failed";
    if (provider.success && req.path === `/storage/oauth/callback/${provider.data}` && typeof state === "string" && opaqueSecret.test(state)) {
      const name = cookieName(state);
      const binder = readCookie(req, name);
      if (binder) {
        res.clearCookie(name, cookieOptions);
        try {
          await oauth.callback(provider.data, {
            state, binder, currentSession: session,
            code: error === undefined && typeof code === "string" && /^[\x21-\x7E]{1,3072}$/.test(code) ? code : undefined,
          });
          outcome = "connected";
        } catch {
          // A fixed redirect never discloses provider data, OAuth material or underlying exceptions.
        }
      }
    }
    res.redirect(303, `/admin/storage?oauth=${outcome}`);
  });
}
