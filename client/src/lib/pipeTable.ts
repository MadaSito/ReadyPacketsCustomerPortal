/**
 * Splits one pipe-table row into cells. A backslash escapes a pipe or another backslash inside a cell
 * (`\|` is a literal pipe, `\\` a literal backslash), matching what the document importer writes.
 */
export function splitPipeRow(line: string): string[] {
  const trimmed = line.trim();
  const cells: string[] = [];
  let current = "";
  let endedOnSeparator = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    const next = trimmed[i + 1];
    if (ch === "\\" && (next === "|" || next === "\\")) {
      current += next;
      i += 1;
      endedOnSeparator = false;
      continue;
    }
    if (ch === "|") {
      cells.push(current);
      current = "";
      endedOnSeparator = true;
      continue;
    }
    current += ch;
    endedOnSeparator = false;
  }
  if (!endedOnSeparator || cells.length === 0) cells.push(current);
  if (trimmed.startsWith("|") && cells.length > 1) cells.shift();
  return cells.map((cell) => cell.trim());
}
