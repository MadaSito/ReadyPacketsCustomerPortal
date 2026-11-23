/**
 * Safe policy body renderer shared across features and `@/lib/agreementGate`.
 * Never interprets raw HTML (`dangerouslySetInnerHTML`) or unsafe URL schemes.
 * Supports headings (`#`, `##`, `###`), bullet/numbered lists, horizontal rules,
 * pipe tables (for D12 imported DOCX/Markdown policies), inline `**bold**` / `*emphasis*` / `` `code` ``,
 * and safe `https://`, `mailto:`, or same-origin `/...` links.
 */
import { type ReactNode } from "react";
import { splitPipeRow } from "../pipeTable";

export type SafePolicyContentFormat = "plain_text" | "safe_markdown";

function isSafeLinkHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  // Same-origin paths only. Browsers read "/\\" like "//", so both forms are refused.
  if (trimmed.startsWith("/")) return !/^\/[/\\]/u.test(trimmed);
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

function renderInlineSafe(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenRegex = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\n]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <strong key={`b-${key++}`} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code key={`c-${key++}`} className="rounded-[var(--radius-control)] bg-surface-sunken px-1.5 py-0.5 text-ink">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("[")) {
      const closeBracket = token.indexOf("](");
      const label = closeBracket > 1 ? token.slice(1, closeBracket) : token;
      const href = closeBracket > 1 ? token.slice(closeBracket + 2, -1) : "";
      if (isSafeLinkHref(href)) {
        const external = !href.startsWith("/");
        nodes.push(
          <a
            key={`a-${key++}`}
            href={href}
            {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            className="font-medium text-action underline underline-offset-2"
          >
            {label}
          </a>,
        );
      } else {
        nodes.push(label);
      }
    } else if (token.startsWith("*") && token.endsWith("*")) {
      nodes.push(
        <span key={`em-${key++}`} className="font-medium text-ink">
          {token.slice(1, -1)}
        </span>,
      );
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const cells = splitPipeRow(trimmed);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function SafePolicyText({
  bodyText,
  format,
}: {
  bodyText: string;
  format: SafePolicyContentFormat;
}) {
  if (format === "plain_text") {
    const paragraphs = bodyText.split(/\n{2,}/);
    return (
      <div className="flex flex-col gap-3 text-body break-words">
        {paragraphs.map((p, idx) => (
          <p key={idx} className="whitespace-pre-line leading-relaxed">
            {p}
          </p>
        ))}
      </div>
    );
  }

  const lines = bodyText.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let idx = 0;

  while (idx < lines.length) {
    const raw = lines[idx] ?? "";
    const trimmed = raw.trim();

    if (!trimmed) {
      idx++;
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      blocks.push(<hr key={`hr-${idx}`} className="my-2 border-line" />);
      idx++;
      continue;
    }

    if (trimmed.startsWith("### ")) {
      blocks.push(
        <h5 key={`h5-${idx}`} className="mt-3 text-base font-semibold text-ink">
          {renderInlineSafe(trimmed.slice(4))}
        </h5>,
      );
      idx++;
      continue;
    }
    if (trimmed.startsWith("## ")) {
      blocks.push(
        <h4 key={`h4-${idx}`} className="mt-4 text-lg font-semibold text-ink">
          {renderInlineSafe(trimmed.slice(3))}
        </h4>,
      );
      idx++;
      continue;
    }
    if (trimmed.startsWith("# ")) {
      blocks.push(
        <h3 key={`h3-${idx}`} className="mt-4 text-xl font-semibold text-ink">
          {renderInlineSafe(trimmed.slice(2))}
        </h3>,
      );
      idx++;
      continue;
    }

    // Markdown pipe table (`| Header | ... |` followed by `| --- | --- |`)
    if (trimmed.includes("|") && idx + 1 < lines.length && isTableSeparatorLine(lines[idx + 1] ?? "")) {
      const start = idx;
      const headers = splitPipeRow(trimmed);
      idx += 2;
      const tableRows: string[][] = [];
      while (idx < lines.length && (lines[idx] ?? "").trim().startsWith("|")) {
        tableRows.push(splitPipeRow(lines[idx] ?? ""));
        idx++;
      }
      blocks.push(
        <div key={`tbl-${start}`} className="overflow-x-auto rounded-[var(--radius-control)] border border-line">
          <table className="w-full border-collapse text-left text-sm text-body">
            <thead className="bg-surface-sunken text-ink">
              <tr>
                {headers.map((header, hIdx) => (
                  <th key={hIdx} scope="col" className="border-b border-line px-3 py-2 font-semibold">
                    {renderInlineSafe(header)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((cells, rIdx) => (
                <tr key={rIdx} className="border-b border-line last:border-b-0">
                  {headers.map((_, cIdx) => (
                    <td key={cIdx} className="px-3 py-2 align-top">
                      {renderInlineSafe(cells[cIdx] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      const start = idx;
      while (idx < lines.length && /^[-*]\s+/.test((lines[idx] ?? "").trim())) {
        items.push((lines[idx] ?? "").trim().replace(/^[-*]\s+/, ""));
        idx++;
      }
      blocks.push(
        <ul key={`ul-${start}`} className="list-disc space-y-1 pl-6 text-body">
          {items.map((item, itemIdx) => (
            <li key={itemIdx}>{renderInlineSafe(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      const start = idx;
      while (idx < lines.length && /^\d+\.\s+/.test((lines[idx] ?? "").trim())) {
        items.push((lines[idx] ?? "").trim().replace(/^\d+\.\s+/, ""));
        idx++;
      }
      blocks.push(
        <ol key={`ol-${start}`} className="list-decimal space-y-1 pl-6 text-body">
          {items.map((item, itemIdx) => (
            <li key={itemIdx}>{renderInlineSafe(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    const paraLines: string[] = [];
    const start = idx;
    while (
      idx < lines.length &&
      (lines[idx] ?? "").trim() !== "" &&
      !/^(#{1,3}\s+|[-*]\s+|\d+\.\s+|---+$)/.test((lines[idx] ?? "").trim()) &&
      !((lines[idx] ?? "").trim().includes("|") && idx + 1 < lines.length && isTableSeparatorLine(lines[idx + 1] ?? ""))
    ) {
      paraLines.push(lines[idx] ?? "");
      idx++;
    }
    blocks.push(
      <p key={`p-${start}`} className="leading-relaxed whitespace-pre-line text-body">
        {renderInlineSafe(paraLines.join("\n"))}
      </p>,
    );
  }

  return <div className="flex flex-col gap-2 break-words">{blocks}</div>;
}
