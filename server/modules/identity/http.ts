/**
 * Identity module — raw HTTP routes. Owner: identity module engineer.
 * Routes mount under /api/identity/… AFTER session resolution and CSRF/origin enforcement (unsafe methods),
 * with the `auth_high_risk` rate-limit category for every path here.
 *
 * Single sign-on (Microsoft Entra ID), canonical paths only (aliases, trailing slashes and case variants 404):
 *   GET  /api/identity/sso/start      sign-in (`?next=`) or session-bound start (`?ticket=`) → 303 to Entra
 *   GET  /api/identity/sso/callback   provider redirect → 303 to /sso/complete?attempt=… or /sso/refused?reason=…
 *   POST /api/identity/sso/complete   JSON { attempt } (CSRF) → finishes the flow
 *   GET  /api/identity/saml/metadata  SP metadata XML (404 unless SAML is selected)
 *   GET  /api/identity/saml/start     same as /sso/start (Entra "Sign on URL")
 *   POST /api/identity/saml/acs       NOT registered here — `createSamlAcsHandler` is mounted as an isolated
 *                                     route (no session / cookie resolution; flat urlencoded form ≤ 256 KiB)
 * The callback's query string is never logged, echoed or placed in a redirect; responses are `no-store` with
 * `Referrer-Policy: no-referrer`.
 */
import type { Request, RequestHandler, Response, Router } from "express";
import type { Services } from "../../container.js";
import { DomainError } from "../../core/errors.js";
import { getHttpState } from "../../http/requestState.js";
import { readCookie } from "../../http/sessionTransport.js";
import { randomToken } from "../../core/ids.js";
import { isSsoRefusal, PENDING_TTL_MS, SSO_CALLBACK_PATH, SSO_START_PATH } from "./sso/service.js";
import { SAML_ACS_PATH, SAML_METADATA_PATH, SAML_START_PATH } from "./sso/saml.js";

export const SSO_COMPLETE_PATH = "/api/identity/sso/complete";

export function ssoBinderCookieName(cookieSecure: boolean): string {
  return cookieSecure ? "__Host-rp_sso" : "rp_sso_dev";
}

function hardenResponse(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
}

/** Exact canonical path (no alias, trailing slash or case variant). */
const exactPath = (req: Request, path: string) => req.originalUrl.split("?")[0] === path;

const one = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export function registerIdentityHttpRoutes(router: Router, services: Services): void {
  const config = services.config;
  const binderName = ssoBinderCookieName(config.cookieSecure);
  const setBinder = (res: Response, value: string) =>
    res.cookie(binderName, value, { path: "/", httpOnly: true, secure: config.cookieSecure, sameSite: "lax", maxAge: PENDING_TTL_MS });
  const clearBinder = (res: Response) => res.clearCookie(binderName, { path: "/", httpOnly: true, secure: config.cookieSecure, sameSite: "lax" });
  const refusedPath = (error: unknown) => `/sso/refused?reason=${isSsoRefusal(error) ? error.reasonCode : "SSO_FAILED"}`;

  const start = (path: string): RequestHandler => async (req, res, next) => {
    if (!exactPath(req, path)) return next();
    hardenResponse(res);
    const sso = services.identity.sso;
    try {
      const ticket = one(req.query.ticket);
      // A fresh binder for every attempt: the previous attempt in this browser can no longer complete.
      const browser = randomToken(32);
      const url = ticket
        ? await sso.startWithTicket({ ticket, session: getHttpState(req).session, browser })
        : await sso.startSignIn({ next: one(req.query.next), browser });
      setBinder(res, browser);
      res.redirect(303, url);
    } catch (error) {
      if (!(error instanceof DomainError)) return next(error);
      res.redirect(303, refusedPath(error));
    }
  };
  router.get("/sso/start", start(SSO_START_PATH));
  router.get("/saml/start", start(SAML_START_PATH));

  router.get("/saml/metadata", async (req, res, next) => {
    if (!exactPath(req, SAML_METADATA_PATH)) return next();
    try {
      const xml = await services.identity.sso.samlMetadata();
      if (!xml) {
        res.status(404).setHeader("Cache-Control", "no-store");
        res.json({ error: { code: "NOT_FOUND" } });
        return;
      }
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.type("application/samlmetadata+xml").send(xml);
    } catch (error) {
      next(error);
    }
  });

  router.get("/sso/callback", async (req, res, next) => {
    if (!exactPath(req, SSO_CALLBACK_PATH)) return next();
    hardenResponse(res);
    try {
      const location = await services.identity.sso.callback({
        state: one(req.query.state),
        code: one(req.query.code),
        error: one(req.query.error),
        browser: readCookie(req, binderName),
      });
      res.redirect(303, location);
    } catch (error) {
      if (!(error instanceof DomainError)) return next(error);
      res.redirect(303, refusedPath(error));
    }
  });

  router.post("/sso/complete", async (req, res, next) => {
    if (!exactPath(req, SSO_COMPLETE_PATH)) return next();
    hardenResponse(res);
    const state = getHttpState(req);
    const body = (req.body ?? {}) as { attempt?: unknown };
    const keys = req.body && typeof req.body === "object" ? Object.keys(req.body as object) : [];
    try {
      if (typeof body.attempt !== "string" || keys.some((k) => k !== "attempt")) {
        throw new DomainError("VALIDATION", "INVALID_INPUT", "The request is not valid.");
      }
      const browser = readCookie(req, binderName);
      clearBinder(res);
      const result = await services.identity.sso.complete({ attempt: body.attempt, browser, session: state.session, userAgent: state.context.userAgent });
      if (result.purpose === "sign_in") {
        // An existing session on this browser ends before the new identity is established (no fixation).
        if (state.session) await services.identity.auth.signOut(state.session);
        state.transport.issue(result.issued);
        res.json({ purpose: result.purpose, next: result.next, nextStep: result.nextStep });
        return;
      }
      if (result.purpose === "step_up") {
        state.transport.issue(result.issued);
        res.json({ purpose: result.purpose, next: result.next });
        return;
      }
      if (result.purpose === "test") {
        res.json({ purpose: result.purpose, next: result.next, test: result.test });
        return;
      }
      res.json({ purpose: result.purpose, next: result.next });
    } catch (error) {
      next(error);
    }
  });
}

/**
 * SAML Assertion Consumer Service — POST /api/identity/saml/acs. Mounted by the HTTP layer as an isolated
 * route after Protection + `auth_high_risk` and BEFORE browser middleware: no session, CSRF or cookie is read
 * or set here (Entra's cross-site form POST carries none we trust). The ingress has already enforced a flat
 * `application/x-www-form-urlencoded` body ≤ 256 KiB with ≤ 2 parameters (else 413/415). RelayState is accepted
 * and ignored. Always answers 303 (to /sso/complete?attempt=… or /sso/refused?reason=…), `no-store`,
 * `no-referrer`; the response body is never echoed or logged.
 */
export function createSamlAcsHandler(services: Services): RequestHandler {
  return async (req, res, next) => {
    hardenResponse(res);
    if (req.originalUrl.split("?")[0] !== SAML_ACS_PATH) {
      res.redirect(303, "/sso/refused?reason=SSO_FAILED");
      return;
    }
    const body: unknown = req.body;
    const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : null;
    const record = (body ?? {}) as Record<string, unknown>;
    const malformed = !keys || !keys.includes("SAMLResponse") || keys.some((k) => k !== "SAMLResponse" && k !== "RelayState")
      || typeof record.SAMLResponse !== "string" || (record.RelayState !== undefined && typeof record.RelayState !== "string");
    try {
      // A malformed field set still goes through acs() (as "no response") so the refusal is audited.
      const location = await services.identity.sso.acs({ samlResponse: malformed ? undefined : record.SAMLResponse });
      res.redirect(303, location);
    } catch (error) {
      if (error instanceof DomainError) {
        res.redirect(303, `/sso/refused?reason=${isSsoRefusal(error) ? error.reasonCode : "SSO_FAILED"}`);
        return;
      }
      next(error);
    }
  };
}
