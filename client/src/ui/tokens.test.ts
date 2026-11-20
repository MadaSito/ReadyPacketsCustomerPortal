import { describe, expect, it } from "vitest";
import { DARK_TOKENS, LIGHT_TOKENS, RENDERED_PAIRS, contrastRatio } from "./tokens";

describe("design tokens — computed contrast (WCAG 2.2 AA target)", () => {
  it("computes known reference ratios", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 1);
  });
  for (const [theme, tokens] of [["light", LIGHT_TOKENS], ["dark", DARK_TOKENS]] as const) {
    for (const [fg, bg, min] of RENDERED_PAIRS) {
      it(`${theme}: ${fg} on ${bg} ≥ ${min}:1`, () => {
        const ratio = contrastRatio(tokens[fg], tokens[bg]);
        expect(ratio, `${theme} ${fg}/${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min);
      });
    }
  }
  it("css file mirrors tokens.ts", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("client/src/styles/index.css", "utf8");
    const [lightBlock, darkBlock] = [css.slice(css.indexOf("@theme"), css.indexOf("html.dark {")), css.slice(css.indexOf("html.dark {"))];
    for (const [name, hex] of Object.entries(LIGHT_TOKENS)) expect(lightBlock).toContain(`--color-${name}: ${hex};`);
    for (const [name, hex] of Object.entries(DARK_TOKENS)) expect(darkBlock).toContain(`--color-${name}: ${hex};`);
  });
});
