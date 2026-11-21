/**
 * Fake Microsoft Entra ID for tests (synthetic keys and claims; no network). Owner: identity module engineer.
 * Publishable test fixture: other modules' tests (assurance, http) may import it.
 *
 *   const idp = createFakeEntra({ tenantId, clientId });
 *   h.services.integrations = { egress: { fetchPinned: idp.fetchPinned } } as never;
 *   const url = await sso.startSignIn({ next: "/", browser });
 *   const { state } = idp.authorize(url, { oid, email, amr: ["pwd", "mfa"] });   // queues an ID token for `code`
 *   await sso.callback({ state, code: idp.code, error: undefined, browser });
 */
import { createSign, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import type { EgressFetchResponse } from "../../integrations/egress.js";
import { entraEndpoints, type Jwk } from "./oidc.js";

export interface FakeEntraIdentity {
  oid: string;
  email?: string | null;
  name?: string;
  amr?: string[];
  roles?: string[];
  /** Override or remove (undefined) any claim. */
  claims?: Record<string, unknown>;
  /** Header overrides, e.g. { alg: "none" } or { kid: "unknown" }. */
  header?: Record<string, unknown>;
  /** Sign with a different key (bad-signature tests). */
  signWith?: KeyObject;
}

export interface FakeEntraCall {
  url: string;
  purpose: string;
  method: string;
  /** Form body with secrets redacted (code / client_secret / code_verifier shown as presence only). */
  form: Record<string, string> | null;
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

export function createFakeEntra(options: { tenantId: string; clientId: string; nowSeconds: () => number }) {
  const keyPair = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
  let current = { kid: `kid-${randomUUID()}`, ...keyPair() };
  let published: Jwk[] = [toJwk(current.kid, current.publicKey)];
  const tokens = new Map<string, string>();
  const calls: FakeEntraCall[] = [];
  let tokenStatus = 200;
  let jwksStatus = 200;
  let codeSeq = 0;

  function toJwk(kid: string, publicKey: KeyObject): Jwk {
    const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
    return { kty: "RSA", use: "sig", kid, n: jwk.n, e: jwk.e } as Jwk;
  }

  function sign(identity: FakeEntraIdentity, nonce: string): string {
    const now = options.nowSeconds();
    const header = { alg: "RS256", typ: "JWT", kid: current.kid, ...identity.header };
    const claims: Record<string, unknown> = {
      iss: entraEndpoints(options.tenantId).issuer,
      aud: options.clientId,
      tid: options.tenantId,
      oid: identity.oid,
      sub: `sub-${identity.oid}`,
      iat: now,
      nbf: now,
      exp: now + 3600,
      auth_time: now,
      nonce,
      amr: identity.amr ?? ["pwd", "mfa"],
      roles: identity.roles ?? [],
      name: identity.name ?? "Synthetic Entra Person",
      ...(identity.email === null ? {} : { email: identity.email ?? `${identity.oid.slice(0, 8)}@contoso.test` }),
      ...identity.claims,
    };
    for (const [k, v] of Object.entries(claims)) if (v === undefined) delete claims[k];
    const input = `${b64(header)}.${b64(claims)}`;
    if (header.alg !== "RS256") return `${input}.`;
    const signer = createSign("RSA-SHA256");
    signer.update(input);
    return `${input}.${signer.sign(identity.signWith ?? current.privateKey).toString("base64url")}`;
  }

  return {
    tenantId: options.tenantId,
    clientId: options.clientId,
    calls,
    /** The most recent authorization code handed out by authorize(). */
    code: "",
    /** Parses an authorization URL, queues a token for a fresh code, and returns state + nonce. */
    authorize(authorizationUrl: string, identity: FakeEntraIdentity): { state: string; nonce: string; code: string } {
      const url = new URL(authorizationUrl);
      const state = url.searchParams.get("state") ?? "";
      const nonce = url.searchParams.get("nonce") ?? "";
      codeSeq += 1;
      const code = `fake-code-${codeSeq}-${randomUUID()}`;
      tokens.set(code, sign(identity, nonce));
      this.code = code;
      return { state, nonce, code };
    },
    /** Rotates the signing key; `publish: false` simulates a key Entra has not published yet. */
    rotate(publish = true) {
      current = { kid: `kid-${randomUUID()}`, ...keyPair() };
      if (publish) published = [...published, toJwk(current.kid, current.publicKey)];
      return current.kid;
    },
    otherKey: () => keyPair().privateKey,
    setTokenStatus: (status: number) => void (tokenStatus = status),
    setJwksStatus: (status: number) => void (jwksStatus = status),
    jwksFetches: () => calls.filter((c) => c.url === entraEndpoints(options.tenantId).jwks).length,
    async fetchPinned(url: string | URL, purpose: string, init: { method?: string; body?: string | Buffer } = {}): Promise<EgressFetchResponse> {
      const href = String(url);
      const ep = entraEndpoints(options.tenantId);
      const json = (status: number, value: unknown): EgressFetchResponse => ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(value)) });
      if (href === ep.jwks) {
        calls.push({ url: href, purpose, method: init.method ?? "GET", form: null });
        return json(jwksStatus, { keys: published });
      }
      if (href === ep.token) {
        const form = Object.fromEntries(new URLSearchParams(String(init.body ?? "")));
        calls.push({
          url: href, purpose, method: init.method ?? "GET",
          form: { ...form, code: form.code ? "[present]" : "", client_secret: form.client_secret ? "[present]" : "", code_verifier: form.code_verifier ? "[present]" : "" },
        });
        if (tokenStatus !== 200) return json(tokenStatus, { error: "invalid_grant" });
        const idToken = form.code ? tokens.get(form.code) : undefined;
        if (!idToken || form.client_id !== options.clientId || !form.code_verifier) return json(400, { error: "invalid_grant" });
        tokens.delete(form.code!); // single use, like Entra
        return json(200, { token_type: "Bearer", id_token: idToken, access_token: "unused" });
      }
      return json(404, { error: "not_found" });
    },
  };
}

export type FakeEntra = ReturnType<typeof createFakeEntra>;
