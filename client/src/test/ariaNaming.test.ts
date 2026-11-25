import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

// Generic and text tags must not be given an accessible name without a naming role.
// Include table cells as a convention: give the table or its headers a name instead.
const checkedTags = new Set([
  "div", "span", "p", "dd", "dt", "td", "strong", "em", "code", "pre",
  "abbr", "b", "i", "s", "small", "sub", "sup", "u",
]);

function unnamedRoleViolations(file: string, code: string): string[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ts.isIdentifier(node.tagName) && checkedTags.has(node.tagName.text)) {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const naming = attributes.find(({ name }) =>
        ts.isIdentifier(name) && (name.text === "aria-label" || name.text === "aria-labelledby"));
      const role = attributes.find(({ name }) => ts.isIdentifier(name) && name.text === "role");
      if (naming && !role?.initializer) {
        const { line } = source.getLineAndCharacterOfPosition(naming.getStart(source));
        findings.push(`${file}:${line + 1} <${node.tagName.text}> has ${naming.name.getText(source)} without a role`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

it("requires a role on JSX text and generic elements with an accessible name", () => {
  const root = resolve(import.meta.dirname, "..");
  const files = readdirSync(root, { encoding: "utf8", recursive: true }).filter((file) => file.endsWith(".tsx")).sort();
  expect(files.length).toBeGreaterThan(0);
  const findings = files.flatMap((file) => {
    const code = readFileSync(join(root, file), "utf8");
    return /aria-label(?:ledby)?\b/.test(code) ? unnamedRoleViolations(file, code) : [];
  });
  expect(findings).toEqual([]);
});

it("detects both naming attributes in multiline and self-closing JSX without matching children", () => {
  expect(unnamedRoleViolations("fixture.tsx", `
    <>
      <div onClick={() => 2 > 1}
        aria-labelledby="heading">
        <span role="status" aria-label="Allowed">Loading</span>
        <code
          aria-label="Not allowed" />
      </div>
    </>
  `)).toEqual([
    "fixture.tsx:4 <div> has aria-labelledby without a role",
    "fixture.tsx:7 <code> has aria-label without a role",
  ]);
});
