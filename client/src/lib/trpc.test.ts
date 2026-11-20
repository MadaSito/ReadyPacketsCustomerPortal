import { describe, expect, it } from "vitest";
import type { Operation } from "@trpc/client";
import { dropInfiniteDirectionLink } from "./trpc";

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
