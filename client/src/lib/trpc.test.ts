import { describe, expect, it, vi } from "vitest";
import { getUntypedClient, type Operation } from "@trpc/client";
import { createApiClient, dropInfiniteDirectionLink } from "./trpc";

const { sessionFetch } = vi.hoisted(() => ({ sessionFetch: vi.fn<typeof fetch>() }));
vi.mock("./sessionTransport", () => ({ sessionFetch }));

function run(op: Partial<Operation>): unknown {
  let seen: unknown;
  const link = dropInfiniteDirectionLink({} as never);
  link({
    op: { id: 1, type: "query", path: "x.list", input: undefined, context: {}, signal: null, ...op } as Operation,
    next: (forwarded) => {
      seen = forwarded.input;
      return { subscribe: () => ({ unsubscribe: () => undefined }), pipe: () => undefined } as never;
    },
  });
  return seen;
}

describe("dropInfiniteDirectionLink", () => {
  it("removes the client-added paging direction from query inputs and keeps the cursor", () => {
    expect(run({ input: { limit: 25, cursor: "abc", direction: "forward" } })).toEqual({ limit: 25, cursor: "abc" });
    expect(run({ input: { direction: "backward" } })).toEqual({});
  });

  it("leaves everything else untouched", () => {
    expect(run({ input: { limit: 25 } })).toEqual({ limit: 25 });
    expect(run({ input: { direction: "asc" } })).toEqual({ direction: "asc" });
    expect(run({ input: undefined })).toBeUndefined();
    expect(run({ input: ["direction"] })).toEqual(["direction"]);
    expect(run({ type: "mutation", input: { direction: "forward" } })).toEqual({ direction: "forward" });
  });
});

describe("workflow transfer HTTP isolation", () => {
  it("sends only preview and applyImport mutations as standalone requests through the session transport", async () => {
    sessionFetch.mockImplementation(async (input) => {
      const target = new URL(String(input), "https://test.invalid");
      const result = { result: { data: { json: "ok" } } };
      return Response.json(target.searchParams.has("batch") ? [result] : result);
    });
    const client = getUntypedClient(createApiClient());
    const prefix = "orders.admin.workflows.transfer";
    const packageText = "{\"synthetic\":true}";
    await client.mutation(`${prefix}.preview`, { packageText });
    await client.mutation(`${prefix}.applyImport`, { packageText, idempotencyKey: "fixture-key" });
    await client.mutation(`${prefix}.export`, { selection: { all: true } });
    await client.mutation(`${prefix}.previewExtra`, {});
    await client.query(`${prefix}.preview`);
    expect(sessionFetch.mock.calls.map(([url, init]) => {
      const target = new URL(String(url), "https://test.invalid");
      return [target.pathname, init?.method, target.searchParams.has("batch")];
    })).toEqual([
      [`/api/trpc/${prefix}.preview`, "POST", false],
      [`/api/trpc/${prefix}.applyImport`, "POST", false],
      [`/api/trpc/${prefix}.export`, "POST", true],
      [`/api/trpc/${prefix}.previewExtra`, "POST", true],
      [`/api/trpc/${prefix}.preview`, "GET", true],
    ]);
    expect(sessionFetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ json: { packageText } }));
  });
});
