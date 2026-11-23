// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { htmlToMarkdown, markdownToHtml } from "../docconvert/markdown";
import { splitPipeRow } from "../pipeTable";
import { SafePolicyText } from "./SafePolicyText";

afterEach(cleanup);

describe("splitPipeRow", () => {
  it("splits plain rows exactly as before", () => {
    expect(splitPipeRow("| Term | Two years |")).toEqual(["Term", "Two years"]);
    expect(splitPipeRow("Term | Two years")).toEqual(["Term", "Two years"]);
    expect(splitPipeRow("| Term | |")).toEqual(["Term", ""]);
    expect(splitPipeRow("| --- | --- |")).toEqual(["---", "---"]);
  });

  it("keeps an escaped pipe and an escaped backslash inside one cell", () => {
    expect(splitPipeRow("| a \\| b | c |")).toEqual(["a | b", "c"]);
    expect(splitPipeRow("| path C:\\\\temp | c |")).toEqual(["path C:\\temp", "c"]);
    // An escaped backslash directly before a separator must not swallow the separator.
    expect(splitPipeRow("| ends with \\\\| next |")).toEqual(["ends with \\", "next"]);
    // A lone backslash before ordinary text is literal.
    expect(splitPipeRow("| a\\b | c |")).toEqual(["a\\b", "c"]);
  });
});

describe("imported table round trip", () => {
  it("renders cells containing pipes and backslashes exactly as authored", () => {
    const html =
      "<table><tr><th>Key</th><th>Value</th></tr><tr><td>A | B</td><td>C:\\temp\\</td></tr></table>";
    // The literal is asserted against the importer's output and then rendered, so both halves of the
    // round trip are pinned to the same text.
    const expected = "| Key | Value |\n| --- | --- |\n| A \\| B | C:\\\\temp\\\\ |";
    expect(htmlToMarkdown(html)).toBe(expected);
    render(<SafePolicyText bodyText={expected} format="safe_markdown" />);
    const cells = screen.getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells).toEqual(["A | B", "C:\\temp\\"]);
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Key", "Value"]);
  });

  it("imports a Markdown table with escaped pipes without splitting the cell", async () => {
    const res = await markdownToHtml("| Key | Value |\n| --- | --- |\n| A \\| B | C |\n");
    const doc = new DOMParser().parseFromString(res.sanitizedHtml, "text/html");
    expect(Array.from(doc.querySelectorAll("td")).map((cell) => cell.textContent)).toEqual(["A | B", "C"]);
  });
});
