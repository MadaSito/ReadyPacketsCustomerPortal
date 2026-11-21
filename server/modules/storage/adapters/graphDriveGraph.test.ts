import { describe, expect, it } from "vitest";
import { type PublishedGraphClient, createGraphDrivePort, mapGraphError } from "./graphDriveGraph.js";
import { GraphTransportError } from "./graphDrivePort.js";

// Structural stub only: the real integrations Graph client was not available when this was tested.
function stub(onRequest: (i: unknown) => unknown, onChunk: (i: unknown) => unknown = () => ({ status: 202, headers: {}, rawBody: Buffer.alloc(0) })) {
  const seen: { scopedWith: unknown[]; requests: unknown[]; chunks: Record<string, unknown>[] } = { scopedWith: [], requests: [], chunks: [] };
  const client: PublishedGraphClient = {
    request: async (i) => {
      seen.requests.push(i);
      return onRequest(i) as never;
    },
    uploadChunk: async (i) => {
      seen.chunks.push(i as never);
      return onChunk(i) as never;
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
    expect(port.supportsRawBody).toBe(false);
  });

  it("refuses raw bodies and absolute or protocol-relative paths", async () => {
    const { port, seen } = stub(() => ({ status: 200, headers: {}, rawBody: Buffer.alloc(0) }));
    await expect(port.request(creds, { method: "PUT", path: "/x", rawBody: Buffer.from("a") })).rejects.toBeInstanceOf(GraphTransportError);
    await expect(port.request(creds, { method: "GET", path: "//evil.example/x" })).rejects.toMatchObject({ code: "EGRESS_DENIED" });
    await expect(port.request(creds, { method: "GET", path: "https://evil.example/x" })).rejects.toMatchObject({ code: "EGRESS_DENIED" });
    expect(seen.requests).toHaveLength(0);
  });

  it("maps Graph errors to statuses or fixed transport codes without provider detail", () => {
    expect(mapGraphError({ name: "GraphApiError", status: 404, message: "secret body" })).toEqual({ status: 404, headers: {}, body: null });
    expect(() => mapGraphError({ reason: "EGRESS_DENIED" })).toThrow(expect.objectContaining({ code: "EGRESS_DENIED" }));
    expect(() => mapGraphError({ reason: "GRAPH_TOKEN_FAILED", status: null })).toThrow(expect.objectContaining({ code: "AUTH_FAILED" }));
    expect(() => mapGraphError({ reason: "GRAPH_TIMEOUT", requestSent: true })).toThrow(expect.objectContaining({ code: "TIMEOUT", retryable: true }));
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
    await expect(port.uploadSessionControl({ url, method: "GET" })).rejects.toBeInstanceOf(GraphTransportError);
  });
});
