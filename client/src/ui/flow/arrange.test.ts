import { describe, expect, it } from "vitest";
import { arrangeFlow } from "./types";

const ids = (...list: string[]) => list.map((id) => ({ id }));

describe("arrangeFlow", () => {
  it("puts each step one column after the nearest step that leads to it", () => {
    const at = arrangeFlow(ids("a", "b", "c", "d"), [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "a", to: "d" },
      { from: "c", to: "a" }, // a loop back to the start does not move the start
    ]);
    expect(at.a!.x).toBe(0);
    expect(at.b!.x).toBe(320);
    expect(at.d!.x).toBe(320);
    expect(at.c!.x).toBe(640);
    expect(at.b!.y).toBeLessThan(at.d!.y);
  });

  it("never stacks two steps on the same spot and stays on the grid", () => {
    const at = arrangeFlow(ids("a", "b", "c", "d", "e"), [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "a", to: "d" }]);
    const spots = Object.values(at).map((p) => `${p.x}:${p.y}`);
    expect(new Set(spots).size).toBe(5);
    for (const p of Object.values(at)) {
      expect(p.x % 20).toBe(0);
      expect(p.y % 20).toBe(0);
    }
  });

  it("handles a pure cycle, unknown ends and self loops", () => {
    const at = arrangeFlow(ids("a", "b"), [{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "a", to: "a" }, { from: "a", to: "zz" }]);
    expect(at).toEqual({ a: { x: 0, y: 0 }, b: { x: 320, y: 0 } });
    expect(arrangeFlow([], [])).toEqual({});
  });
});
