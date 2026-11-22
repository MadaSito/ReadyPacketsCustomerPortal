/**
 * Community post body: parse the stored constrained plain text into a small tree and render React elements.
 * Never uses innerHTML. Only `https:` URLs without credentials become links, always with
 * rel="noopener noreferrer nofollow ugc". Owner: audit_engineer (package M).
 */
import { Fragment, useEffect, type ReactNode } from "react";

export type Inline = { kind: "text"; text: string } | { kind: "code"; text: string } | { kind: "link"; href: string; text: string };
export type Block =
  | { kind: "paragraph"; lines: Inline[][] }
  | { kind: "quote"; lines: Inline[][] }
  | { kind: "list"; items: Inline[][] };

export const LINK_REL = "noopener noreferrer nofollow ugc";
const TRAILING = /[.,;:!?)\]'"]+$/u;

export function safeHref(candidate: string): string | null {
  if (!candidate.startsWith("https://") || candidate.length > 2048) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hostname === "") return null;
    return url.href;
  } catch {
    return null;
  }
}

function linkify(text: string, out: Inline[]): void {
  const parts = text.split(/(https:\/\/[^\s<>"'`]+)/u);
  for (const part of parts) {
    if (part === "") continue;
    if (part.startsWith("https://")) {
      const trailing = TRAILING.exec(part)?.[0] ?? "";
      const core = trailing ? part.slice(0, -trailing.length) : part;
      const href = safeHref(core);
      if (href) {
        out.push({ kind: "link", href, text: core });
        if (trailing) out.push({ kind: "text", text: trailing });
        continue;
      }
    }
    out.push({ kind: "text", text: part });
  }
}

export function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  const segments = line.split("`");
  // An odd number of backticks leaves the last one literal.
  const paired = segments.length % 2 === 1 ? segments : [...segments.slice(0, -2), `${segments.at(-2)}\`${segments.at(-1)}`];
  paired.forEach((seg, i) => {
    if (i % 2 === 1) {
      if (seg.length > 0) out.push({ kind: "code", text: seg });
      else out.push({ kind: "text", text: "``" });
    } else if (seg.length > 0) linkify(seg, out);
  });
  return out;
}

export function parseBody(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.replace(/\r\n?/gu, "\n").split(/\n{2,}/u)) {
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;
    if (lines.every((l) => l.startsWith(">"))) blocks.push({ kind: "quote", lines: lines.map((l) => parseInline(l.replace(/^>\s?/u, ""))) });
    else if (lines.every((l) => /^[-*]\s/u.test(l))) blocks.push({ kind: "list", items: lines.map((l) => parseInline(l.replace(/^[-*]\s+/u, ""))) });
    else blocks.push({ kind: "paragraph", lines: lines.map(parseInline) });
  }
  return blocks;
}

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((n, i) =>
    n.kind === "code" ? (
      <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{n.text}</code>
    ) : n.kind === "link" ? (
      <a key={i} href={n.href} rel={LINK_REL} className="break-all text-primary underline underline-offset-2">{n.text}</a>
    ) : (
      <Fragment key={i}>{n.text}</Fragment>
    ),
  );
}

function lines(ls: Inline[][]): ReactNode {
  return ls.map((l, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {renderInline(l)}
    </Fragment>
  ));
}

export function CommunityBody({ text, className }: { text: string; className?: string }) {
  return (
    <div className={["space-y-3 break-words text-sm leading-relaxed", className].filter(Boolean).join(" ")}>
      {parseBody(text).map((b, i) =>
        b.kind === "quote" ? (
          <blockquote key={i} className="border-l-4 border-line pl-3 text-muted">{lines(b.lines)}</blockquote>
        ) : b.kind === "list" ? (
          <ul key={i} className="list-disc space-y-1 pl-5">{b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ul>
        ) : (
          <p key={i}>{lines(b.lines)}</p>
        ),
      )}
    </div>
  );
}

/** Community pages are not for search engines (decision 7). Adds/restores `<meta name="robots">`. */
export function useCommunityNoindex(): void {
  useEffect(() => {
    let meta = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = meta === null;
    const previous = meta?.content ?? null;
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "robots";
      document.head.appendChild(meta);
    }
    meta.content = "noindex, nofollow";
    return () => {
      if (created) meta?.remove();
      else if (meta && previous !== null) meta.content = previous;
    };
  }, []);
}

/** Text for posts whose body the viewer may not read. */
export function hiddenBodyLabel(state: string): string {
  if (state === "pending") return "This post is waiting for review by a moderator.";
  if (state === "hidden") return "This post was hidden by a moderator.";
  if (state === "deleted") return "This post was deleted by its author.";
  return "This post was removed by a moderator.";
}
