/** Increment 08 (D2): pure reference stem builder — table-driven (no database). */
import { describe, expect, it } from "vitest";
import { buildReferenceStem, foldReferencePart, REFERENCE_PATTERN, stemOfReference } from "./references.js";

type StemInput = Parameters<typeof buildReferenceStem>[0];
const base: StemInput = { prefix: "RP", customerRef: "RPCUS-A1B2CJJG5", firstName: "Zeus", lastName: "Greene", projectName: "Ice Queen" };

describe("buildReferenceStem", () => {
  const cases: { name: string; input: Partial<StemInput>; stem: string }[] = [
    { name: "contract example", input: {}, stem: "RP-JJG5-ZEUGRE-ICEQUE" },
    { name: "diacritics fold to Latin", input: { firstName: "Zoë", lastName: "Grëéne", projectName: "Île Quéen" }, stem: "RP-JJG5-ZOEGRE-ILEQUE" },
    { name: "non-Latin letters fold to nothing and pad with X", input: { firstName: "Зевс", lastName: "グリーン", projectName: "冰雪女王" }, stem: "RP-JJG5-XXXXXX-XXXXXX" },
    { name: "short parts pad right with X", input: { firstName: "Li", lastName: "O", projectName: "Ab" }, stem: "RP-JJG5-LIXOXX-ABXXXX" },
    { name: "empty last name (one-word display name)", input: { lastName: "" }, stem: "RP-JJG5-ZEUXXX-ICEQUE" },
    { name: "punctuation and spaces are dropped", input: { firstName: "Z.-e'u s", lastName: "G-r_e!e", projectName: "Ice, Queen & Co." }, stem: "RP-JJG5-ZEUGRE-ICEQUE" },
    { name: "emoji are dropped", input: { firstName: "😀Zeus", lastName: "Gr🎉eene", projectName: "🧊 Ice 👑 Queen" }, stem: "RP-JJG5-ZEUGRE-ICEQUE" },
    { name: "very long parts are cut", input: { firstName: "Zeusandmanymore", lastName: "Greenefieldsforever", projectName: "Ice Queen and the very long sequel name" }, stem: "RP-JJG5-ZEUGRE-ICEQUE" },
    { name: "digits are kept", input: { firstName: "Z3us", projectName: "2026 Ice" }, stem: "RP-JJG5-Z3UGRE-2026IC" },
    { name: "no customer ID → 0000", input: { customerRef: null }, stem: "RP-0000-ZEUGRE-ICEQUE" },
    { name: "short customer ID pads left with 0", input: { customerRef: "C7" }, stem: "RP-00C7-ZEUGRE-ICEQUE" },
    { name: "lower-case input is upper-cased", input: { customerRef: "rpcus-a1b2cjjg5", firstName: "zeus", lastName: "greene" }, stem: "RP-JJG5-ZEUGRE-ICEQUE" },
    { name: "longest prefix", input: { prefix: "ABCDEF" }, stem: "ABCDEF-JJG5-ZEUGRE-ICEQUE" },
    { name: "ligatures and full-width forms decompose (NFKD)", input: { firstName: "ﬁona", projectName: "Ｉｃｅ Ｑｕｅｅｎ" }, stem: "RP-JJG5-FIOGRE-ICEQUE" },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const stem = buildReferenceStem({ ...base, ...c.input });
      expect(stem).toBe(c.stem);
      for (const nnn of ["001", "999", "1000", "999999"]) {
        const reference = `${stem}-${nnn}`;
        expect(reference.length).toBeLessThanOrEqual(32);
        expect(REFERENCE_PATTERN.test(reference)).toBe(true);
        expect(stemOfReference(reference)).toBe(stem);
      }
    });
  }

  it("folds to A–Z and 0–9 only", () => {
    expect(foldReferencePart("Ångström-µ 9")).toBe("ANGSTROM9");
    expect(foldReferencePart(null)).toBe("");
  });

  it("does not recognise the older RP-YYYY-NNNNNN shape as a stem reference", () => {
    expect(stemOfReference("RP-2026-000123")).toBeNull();
    expect(stemOfReference("RP-JJG5-ZEUGRE-ICEQUE-01")).toBeNull();
  });
});
