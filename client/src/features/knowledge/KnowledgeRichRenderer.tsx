/**
 * Safe React AST renderer for sanitised Knowledge Base articles and search highlights.
 * Zero `dangerouslySetInnerHTML`: renders typed `KnowledgeRichBlock[]` directly to semantic React elements.
 */
import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import type {
  KnowledgeInlineNode,
  KnowledgeListItemNode,
  KnowledgeRichBlock,
  KnowledgeSnippetSegment,
} from "@server/modules/knowledge/types";
import { Link } from "wouter";
import { CodeBlock } from "@/ui";

function renderInlineNodes(nodes: readonly KnowledgeInlineNode[], keyPrefix: string): ReactNode {
  return nodes.map((node, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (node.kind) {
      case "text":
        return node.text;
      case "br":
        return <br key={key} />;
      case "strong":
        return (
          <strong key={key} className="font-semibold text-ink">
            {renderInlineNodes(node.children, key)}
          </strong>
        );
      case "em":
        return (
          <em key={key} className="italic">
            {renderInlineNodes(node.children, key)}
          </em>
        );
      case "code":
        return (
          <code
            key={key}
            className="rounded bg-surface-soft px-1.5 py-0.5 font-mono text-sm text-ink border border-line"
          >
            {node.text}
          </code>
        );
      case "link": {
        if (!node.external && node.href.startsWith("/")) {
          return (
            <Link
              key={key}
              href={node.href}
              className="font-medium text-action underline underline-offset-2 hover:opacity-90 break-words"
            >
              {renderInlineNodes(node.children, key)}
            </Link>
          );
        }
        return (
          <a
            key={key}
            href={node.href}
            target={node.external ? "_blank" : undefined}
            rel={node.external ? "noopener noreferrer" : undefined}
            className="inline-flex items-baseline gap-1 font-medium text-action underline underline-offset-2 hover:opacity-90 break-words"
          >
            <span>{renderInlineNodes(node.children, key)}</span>
            {node.external ? (
              <ExternalLink className="inline h-3.5 w-3.5 shrink-0 self-center" aria-hidden />
            ) : null}
          </a>
        );
      }
    }
  });
}

function renderListItems(
  items: readonly KnowledgeListItemNode[],
  ordered: boolean,
  keyPrefix: string,
): ReactNode {
  const ListTag = ordered ? "ol" : "ul";
  const listCls = ordered
    ? "ml-5 flex list-decimal flex-col gap-1.5 text-body"
    : "ml-5 flex list-disc flex-col gap-1.5 text-body";
  return (
    <ListTag className={listCls}>
      {items.map((item, idx) => {
        const itemKey = `${keyPrefix}-li-${idx}`;
        return (
          <li key={itemKey} className="min-w-0 pl-1">
            <div>{renderInlineNodes(item.inlines, itemKey)}</div>
            {item.sublists?.map((sub, subIdx) => (
              <div key={`${itemKey}-sub-${subIdx}`} className="mt-1.5">
                {renderListItems(sub.items, sub.ordered, `${itemKey}-sub-${subIdx}`)}
              </div>
            ))}
          </li>
        );
      })}
    </ListTag>
  );
}

export interface KnowledgeRichRendererProps {
  blocks: readonly KnowledgeRichBlock[];
  className?: string;
}

export function KnowledgeRichRenderer({ blocks, className }: KnowledgeRichRendererProps) {
  return (
    <div
      className={`flex min-w-0 flex-col gap-4 text-body leading-relaxed break-words ${className ?? ""}`}
    >
      {blocks.map((block, index) => {
        const key = `blk-${index}`;
        switch (block.kind) {
          case "heading": {
            const commonCls =
              "scroll-mt-20 font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-action rounded-[var(--radius-control)]";
            if (block.level === 2) {
              return (
                <h2 key={key} id={block.id} tabIndex={-1} className={`mt-3 text-xl ${commonCls}`}>
                  {renderInlineNodes(block.children, key)}
                </h2>
              );
            }
            if (block.level === 3) {
              return (
                <h3 key={key} id={block.id} tabIndex={-1} className={`mt-2 text-lg ${commonCls}`}>
                  {renderInlineNodes(block.children, key)}
                </h3>
              );
            }
            return (
              <h4 key={key} id={block.id} tabIndex={-1} className={`mt-2 text-base ${commonCls}`}>
                {renderInlineNodes(block.children, key)}
              </h4>
            );
          }

          case "paragraph":
            return (
              <p key={key} className="min-w-0 text-body leading-relaxed">
                {renderInlineNodes(block.children, key)}
              </p>
            );

          case "list":
            return <div key={key}>{renderListItems(block.items, block.ordered, key)}</div>;

          case "blockquote":
            return (
              <blockquote
                key={key}
                className="rp-print-avoid-break rounded-r-[var(--radius-control)] border-l-4 border-action bg-surface-soft px-4 py-3 text-body"
              >
                {renderInlineNodes(block.children, key)}
              </blockquote>
            );

          case "code_block":
            return (
              <div key={key} className="rp-print-avoid-break min-w-0">
                <CodeBlock label="Article code sample" copyable wrap>
                  {block.code}
                </CodeBlock>
              </div>
            );

          case "hr":
            return <hr key={key} className="my-2 border-line" />;

          case "image":
            return (
              <figure key={key} className="rp-print-avoid-break my-2 flex flex-col gap-1.5">
                <img
                  src={block.src}
                  alt={block.alt}
                  loading="lazy"
                  className="max-w-full rounded-[var(--radius-card)] border border-line"
                />
                {block.alt ? <figcaption className="text-sm text-muted">{block.alt}</figcaption> : null}
              </figure>
            );

          case "table":
            return (
              <div
                key={key}
                className="rp-print-avoid-break min-w-0 overflow-x-auto rounded-[var(--radius-card)] border border-line"
              >
                <table className="w-full border-collapse text-left text-sm">
                  {block.headers.length > 0 ? (
                    <thead className="bg-surface-soft text-ink">
                      <tr>
                        {block.headers.map((cell, cIdx) => (
                          <th
                            key={`${key}-th-${cIdx}`}
                            scope="col"
                            className="border-b border-line px-3 py-2 font-semibold"
                          >
                            {renderInlineNodes(cell, `${key}-th-${cIdx}`)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                  ) : null}
                  <tbody>
                    {block.rows.map((row, rIdx) => (
                      <tr key={`${key}-tr-${rIdx}`} className="border-b border-line last:border-b-0">
                        {row.map((cell, cIdx) => (
                          <td key={`${key}-td-${rIdx}-${cIdx}`} className="px-3 py-2 text-body">
                            {renderInlineNodes(cell, `${key}-td-${rIdx}-${cIdx}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}

export function HighlightSegments({
  segments,
}: {
  segments: readonly KnowledgeSnippetSegment[];
}) {
  return (
    <>
      {segments.map((seg, idx) =>
        seg.highlight ? (
          <mark key={idx} className="rounded bg-warning-soft px-0.5 font-semibold text-ink">
            {seg.text}
          </mark>
        ) : (
          <span key={idx}>{seg.text}</span>
        ),
      )}
    </>
  );
}

export function formatAttachmentBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
