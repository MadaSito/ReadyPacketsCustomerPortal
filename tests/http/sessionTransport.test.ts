// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HEADER_CSRF, HEADER_PREVIEW_CSRF_SET, HEADER_PREVIEW_SESSION, HEADER_PREVIEW_SESSION_SET,
} from "../../shared/sessionTransportHeaders.js";

function runtime(name: "standard" | "preview", apiBase = ""): void {
  for (const [key, value] of [["rp-runtime", name], ["rp-api-base", apiBase]]) {
    const meta = document.createElement("meta");
    meta.name = key!;
    meta.content = value!;
    document.head.append(meta);
  }
}

afterEach(() => {
  document.head.replaceChildren();
  document.cookie = "rp_csrf_dev=; Path=/; Max-Age=0";
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("browser session transport", () => {
  it("bootstraps the readable CSRF cookie before one write and rejects non-API destinations", async () => {
    runtime("standard");
    const fetch = vi.fn(async (target: string, _options?: RequestInit) => {
      if (target === "/api/csrf") document.cookie = "rp_csrf_dev=synthetic-csrf; Path=/";
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetch);
    const { clearPreviewCredentials, sessionFetch } = await import("../../client/src/lib/sessionTransport.js");
    await expect(sessionFetch("https://external.example.test/api/trpc/action", { method: "POST" })).rejects.toThrow(/portal API/);
    expect(fetch).not.toHaveBeenCalled();
    await sessionFetch("/api/mutate", { method: "POST", headers: { [HEADER_PREVIEW_SESSION]: "ignored" } });
    clearPreviewCredentials();
    expect(document.cookie).toContain("rp_csrf_dev=synthetic-csrf");
    expect(fetch.mock.calls.map(([target]) => target)).toEqual(["/api/csrf", "/api/mutate"]);
    expect(fetch.mock.calls[1]?.[1]?.headers).toBeInstanceOf(Headers);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get(HEADER_CSRF)).toBe("synthetic-csrf");
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get(HEADER_PREVIEW_SESSION)).toBeNull();
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ credentials: "same-origin", redirect: "error" });
  });

  it("holds preview credentials in memory, sends no ambient credentials, and drops stale responses after logout", async () => {
    runtime("preview", "https://preview.example.test/proxy");
    const mark = (headers: Record<string, string> = {}) => new Response(null, { status: 204, headers });
    let delayed: (value: Response) => void = () => { throw new Error("no pending response"); };
    const fetch = vi.fn((target: string, _options?: RequestInit): Promise<Response> => {
      if (target.endsWith("/csrf")) return Promise.resolve(mark({ [HEADER_PREVIEW_CSRF_SET]: "anonymous-stub" }));
      if (target.endsWith("/signIn")) return Promise.resolve(mark({
        [HEADER_PREVIEW_SESSION_SET]: "synthetic-preview-session", [HEADER_PREVIEW_CSRF_SET]: "signed-stub",
      }));
      if (target.endsWith("/delayed")) return new Promise((resolve) => { delayed = resolve; });
      return Promise.resolve(mark({ [HEADER_PREVIEW_SESSION_SET]: "", [HEADER_PREVIEW_CSRF_SET]: "" }));
    });
    vi.stubGlobal("fetch", fetch);
    const { sessionFetch, sessionHeaders } = await import("../../client/src/lib/sessionTransport.js");
    const endpoint = (name: string) => `https://preview.example.test/proxy/api/${name}`;
    await sessionFetch(endpoint("signIn"), { method: "POST" });
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get(HEADER_CSRF)).toBe("anonymous-stub");
    expect(sessionHeaders()).toMatchObject({ [HEADER_PREVIEW_SESSION]: "synthetic-preview-session", [HEADER_CSRF]: "signed-stub" });
    const oldRequest = sessionFetch(endpoint("delayed"));
    await sessionFetch(endpoint("trpc/identity.signOut?batch=1"), { method: "POST" });
    delayed(mark({ [HEADER_PREVIEW_SESSION_SET]: "stale-synthetic-session", [HEADER_PREVIEW_CSRF_SET]: "stale-stub" }));
    await oldRequest;
    expect(sessionHeaders()).toEqual({});
    expect(document.cookie).toBe("");
    expect(fetch.mock.calls.every(([, init]) => init?.credentials === "omit" && init.redirect === "error")).toBe(true);
  });

  it("clears preview credentials at sign-out dispatch even if the revocation request fails", async () => {
    runtime("preview", "https://preview.example.test/proxy");
    const endpoint = (path: string) => `https://preview.example.test/proxy/api/${path}`;
    const mark = (headers: Record<string, string> = {}) => new Response(null, { status: 204, headers });
    let failRevocation: (error: Error) => void = () => { throw new Error("no pending revocation"); };
    const fetch = vi.fn((target: string, _options?: RequestInit): Promise<Response> => {
      if (target.endsWith("/csrf")) return Promise.resolve(mark({ [HEADER_PREVIEW_CSRF_SET]: "anonymous-stub" }));
      if (target.includes("identity.signIn")) return Promise.resolve(mark({
        [HEADER_PREVIEW_SESSION_SET]: "synthetic-preview-session", [HEADER_PREVIEW_CSRF_SET]: "signed-stub",
      }));
      if (target.includes("identity.signOut")) return new Promise((_resolve, reject) => { failRevocation = reject; });
      return Promise.resolve(mark());
    });
    vi.stubGlobal("fetch", fetch);
    const { onSessionChanged, sessionFetch, sessionHeaders } = await import("../../client/src/lib/sessionTransport.js");
    await sessionFetch(endpoint("trpc/identity.signIn?batch=1"), { method: "POST" });
    const listener = vi.fn();
    onSessionChanged(listener);
    const attempt = sessionFetch(endpoint("trpc/identity.signOut?batch=1"), { method: "POST" });
    expect(sessionHeaders()).toEqual({});
    expect(listener).toHaveBeenCalledOnce();
    expect(Object.fromEntries(new Headers(fetch.mock.calls[2]?.[1]?.headers))).toMatchObject({
      [HEADER_PREVIEW_SESSION.toLowerCase()]: "synthetic-preview-session", [HEADER_CSRF.toLowerCase()]: "signed-stub",
    });
    await sessionFetch(endpoint("trpc/identity.me?batch=1"));
    expect(new Headers(fetch.mock.calls[3]?.[1]?.headers).has(HEADER_PREVIEW_SESSION)).toBe(false);
    failRevocation(new Error("synthetic network failure"));
    await expect(attempt).rejects.toThrow("synthetic network failure");
    expect(sessionHeaders()).toEqual({});
  });
});
