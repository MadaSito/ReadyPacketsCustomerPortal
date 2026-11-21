import { describe, expect, it } from "vitest";
import { type PublishedGraphClient, createGraphDrivePort, mapGraphError } from "./graphDriveGraph.js";
import { createGraphClientFromResolver } from "../../integrations/graph/client.js";
import { GraphApiError } from "../../integrations/graph/types.js";

// Structural stub tests first; then the real integrations client (7668b53) over a LOCAL fake egress + token cache.
function stub(onRequest: (i: unknown) => unknown, onChunk: (i: unknown) => unknown = () => ({ status: 202, headers: {}, rawBody: Buffer.alloc(0) })) {
  const seen: { scopedWith: unknown[]; requests: unknown[]; chunks: Record<string, unknown>[] } = { scopedWith: [], requests: [], chunks: [] };
  const client: PublishedGraphClient = {
    request: async (i) => {
      seen.requests.push(i);
      return onRequest(i) as never;
    },
    uploadChunk: async (i) => {
      await i.beforeSend?.(); // the real client runs the fence before the wire
      seen.chunks.push(i as never);
      return onChunk(i) as never;
    },
    uploadSessionControl: async (i) => {
      seen.chunks.push(i as never);
      await i.beforeSend?.();
      return { status: 200, headers: {}, rawBody: Buffer.from('{"nextExpectedRanges":["3-"]}') };
    },
  };
  const port = createGraphDrivePort(
    (creds) => {
      seen.scopedWith.push(creds);
      return client;
    },
    () => client,
  );
  return { port, seen };
}

const creds = { tenantId: "t", clientId: "c", clientSecret: "s" };

describe("graph drive port binding (structural stub)", () => {
  it("passes requests through a client scoped to the connection credentials and parses JSON", async () => {
    const { port, seen } = stub(() => ({ status: 200, headers: { "Content-Type": "application/json" }, rawBody: Buffer.from('{"id":"x"}') }));
    const r = await port.request(creds, { method: "GET", path: "/drives/x", query: { $select: "id" } });
    expect(r).toEqual({ status: 200, headers: { "content-type": "application/json" }, body: { id: "x" } });
    expect(seen.scopedWith).toEqual([creds]);
    expect(seen.requests[0]).toMatchObject({ method: "GET", path: "/drives/x", maxResponseBytes: 4 * 1024 * 1024 });
    expect(port.supportsRawBody).toBe(true);
  });

  it("passes raw bodies as bytes and refuses absolute or protocol-relative paths", async () => {
    const { port, seen } = stub(() => ({ status: 201, headers: {}, rawBody: Buffer.alloc(0) }));
    expect((await port.request(creds, { method: "PUT", path: "/x", rawBody: Buffer.from("ab") })).status).toBe(201);
    const sent = seen.requests.pop() as { rawBody?: Uint8Array; body?: unknown };
    expect(Buffer.from(sent.rawBody!).toString()).toBe("ab");
    expect(sent).not.toHaveProperty("body");
    await expect(port.request(creds, { method: "GET", path: "//evil.example/x" })).rejects.toMatchObject({ code: "EGRESS_DENIED" });
    await expect(port.request(creds, { method: "GET", path: "https://evil.example/x" })).rejects.toMatchObject({ code: "EGRESS_DENIED" });
    expect(seen.requests).toHaveLength(0);
  });

  it("maps Graph errors to statuses or fixed transport codes without provider detail", () => {
    expect(mapGraphError({ name: "GraphApiError", status: 404, message: "secret body" })).toEqual({ status: 404, headers: {}, body: null });
    expect(() => mapGraphError({ reason: "EGRESS_DENIED" })).toThrow(expect.objectContaining({ code: "EGRESS_DENIED" }));
    expect(() => mapGraphError({ reason: "GRAPH_TOKEN_FAILED", status: null })).toThrow(expect.objectContaining({ code: "AUTH_FAILED" }));
    expect(() => mapGraphError({ reason: "GRAPH_TIMEOUT", requestSent: true })).toThrow(expect.objectContaining({ code: "TIMEOUT", retryable: true }));
    // Real GraphApiError instances (reasonCode on DomainError).
    const real = (reasonCode: string, status: number | null = null) => new GraphApiError({ code: "UNAVAILABLE", reasonCode, safeMessage: "x", status, retryable: true, requestSent: false });
    expect(() => mapGraphError(real("EGRESS_HOST_NOT_ALLOWED"))).toThrow(expect.objectContaining({ code: "EGRESS_DENIED" }));
    expect(() => mapGraphError(real("GRAPH_TIMEOUT"))).toThrow(expect.objectContaining({ code: "TIMEOUT" }));
    expect(() => mapGraphError(real("GRAPH_RESPONSE_TOO_LARGE"))).toThrow(expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }));
    expect(() => mapGraphError(real("GRAPH_TOKEN_REQUEST_FAILED"))).toThrow(expect.objectContaining({ code: "AUTH_FAILED" }));
    expect(mapGraphError(real("GRAPH_HTTP_409", 409))).toEqual({ status: 409, headers: {}, body: null });
    expect(() => mapGraphError(new Error("boom https://x.sharepoint.com/upload?tempauth=abc"))).toThrow(expect.objectContaining({ code: "NETWORK" }));
    try {
      mapGraphError(new Error("https://x.sharepoint.com/upload?tempauth=abc"));
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("tempauth");
    }
  });

  it("sends chunks through uploadChunk narrowed to the checked host, with no credentials", async () => {
    const { port, seen } = stub(() => ({}));
    const url = new URL("https://contoso.sharepoint.com/_api/upload?tempauth=synthetic");
    const r = await port.uploadSessionPut({ url, body: Buffer.from("abc"), contentRange: "bytes 0-2/3" });
    expect(r.status).toBe(202);
    expect(seen.chunks[0]).toMatchObject({ allowedHostSuffixes: ["contoso.sharepoint.com"], contentRange: "bytes 0-2/3" });
    expect(seen.chunks[0]).not.toHaveProperty("headers");
    expect(seen.scopedWith).toHaveLength(0);
    await expect(port.uploadSessionPut({ url: new URL("https://contoso.sharepoint.com:8443/x"), body: Buffer.from("a"), contentRange: "bytes 0-0/1" })).rejects.toMatchObject({ code: "EGRESS_DENIED" });
    const control = await port.uploadSessionControl({ url, method: "GET" });
    expect(control.body).toEqual({ nextExpectedRanges: ["3-"] });
    expect(seen.chunks[1]).toMatchObject({ method: "GET", allowedHostSuffixes: ["contoso.sharepoint.com"] });
    await expect(port.uploadSessionControl({ url: new URL("http://contoso.sharepoint.com/x"), method: "DELETE" })).rejects.toMatchObject({ code: "EGRESS_DENIED" });
  });

  it("passes the write fence to the client and rethrows a lost fence unchanged", async () => {
    const lost = new Error("lease lost");
    let calls = 0;
    const { port } = stub(async (i) => {
      await (i as { beforeSend?: () => Promise<void> }).beforeSend?.();
      return { status: 201, headers: {}, rawBody: Buffer.alloc(0) };
    });
    await port.request(creds, { method: "POST", path: "/x", body: {}, beforeSend: async () => void calls++ });
    expect(calls).toBe(1); // exactly once, by the client after token acquisition
    await expect(port.request(creds, { method: "POST", path: "/x", body: {}, beforeSend: async () => { throw lost; } })).rejects.toBe(lost);
    await expect(port.uploadSessionPut({ url: new URL("https://contoso.sharepoint.com/u"), body: Buffer.from("a"), contentRange: "bytes 0-0/1", beforeSend: async () => { throw lost; } })).rejects.toBe(lost);
    await expect(port.uploadSessionControl({ url: new URL("https://contoso.sharepoint.com/u"), method: "DELETE", beforeSend: async () => { throw lost; } })).rejects.toBe(lost);
  });
});

describe("graph drive port bound to the real integrations GraphClient (local fake egress, no tenant)", () => {
  function real(respond: (url: string, purpose: string, init: Record<string, unknown>) => { status: number; body?: string }) {
    const order: string[] = [];
    const wire: { url: string; purpose: string; init: Record<string, unknown> }[] = [];
    const egress = {
      fetchPinned: async (url: string, purpose: string, init: Record<string, unknown> & { beforeSend?: () => Promise<void> }) => {
        await init.beforeSend?.();
        order.push("wire");
        wire.push({ url, purpose, init });
        const r = respond(url, purpose, init);
        return { status: r.status, headers: { "content-type": "application/json" }, body: Buffer.from(r.body ?? "") };
      },
    };
    const tokenCache = { getAccessToken: async () => (order.push("token"), "synthetic-token"), invalidate: () => undefined };
    const client = createGraphClientFromResolver(egress as never, tokenCache as never, async () => ({ tenantId: "t", clientId: "c", clientSecret: "s" }));
    const port = createGraphDrivePort(() => client as never, () => client as never);
    return { port, order, wire };
  }

  it("sends JSON and raw bytes with the bearer token, fence after token acquisition", async () => {
    const { port, order, wire } = real(() => ({ status: 201, body: '{"id":"i1"}' }));
    const fenceOrder: string[] = [];
    const r = await port.request(creds, { method: "PUT", path: "/drives/d/root:/a.bin:/content", rawBody: Buffer.from("xyz"), beforeSend: async () => void (order.push("fence"), fenceOrder.push("f")) });
    expect(r).toMatchObject({ status: 201, body: { id: "i1" } });
    expect(order).toEqual(["token", "fence", "wire"]);
    expect(wire[0]!.purpose).toBe("graph");
    expect(Buffer.from(wire[0]!.init.body as Uint8Array).toString()).toBe("xyz");
    expect((wire[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer synthetic-token");
  });

  it("maps HTTP errors to statuses and never sends after a lost fence", async () => {
    const { port, wire } = real(() => ({ status: 409, body: '{"error":{"code":"nameAlreadyExists","message":"secret"}}' }));
    expect(await port.request(creds, { method: "POST", path: "/x", body: {} })).toEqual({ status: 409, headers: {}, body: null });
    const lost = new Error("lease lost");
    const before = wire.length;
    await expect(port.request(creds, { method: "POST", path: "/x", body: {}, beforeSend: async () => { throw lost; } })).rejects.toBe(lost);
    expect(wire.length).toBe(before);
  });

  it("controls upload sessions on graph_upload without credentials, narrowed to the checked host", async () => {
    const { port, wire } = real(() => ({ status: 200, body: '{"nextExpectedRanges":["5-"]}' }));
    const url = new URL("https://contoso.sharepoint.com/_api/upload?tempauth=synthetic");
    expect((await port.uploadSessionControl({ url, method: "GET" })).body).toEqual({ nextExpectedRanges: ["5-"] });
    expect(wire[0]).toMatchObject({ purpose: "graph_upload", init: { method: "GET", expectedHostSuffixes: ["contoso.sharepoint.com"] } });
    expect(JSON.stringify(wire[0]!.init.headers)).not.toMatch(/authorization|cookie/iu);
    const lost = new Error("lease lost");
    await expect(port.uploadSessionControl({ url, method: "DELETE", beforeSend: async () => { throw lost; } })).rejects.toBe(lost);
    expect(wire).toHaveLength(1);
  });
});
