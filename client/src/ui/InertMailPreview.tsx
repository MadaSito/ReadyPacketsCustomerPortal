import { cn } from "./cn";
import { Tabs } from "./Navigation";

export interface InertMailPreviewProps {
  /** Accessible name of the preview, e.g. "Preview of Password reset". */
  title: string;
  /** The SERVER's structural preview projection (no href/src/srcset, forms, meta/base, styles, SVG/MathML). */
  html?: string;
  /** Plain-text alternative; always shown as its own tab. */
  text: string;
  height?: "sm" | "md" | "lg";
}

/** First element of the frame's document. Inherited parent policy still applies; this only narrows it. */
export const INERT_PREVIEW_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'";

const heights = { sm: "h-64", md: "h-96", lg: "h-[36rem]" } as const;

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Builds the frame document. `html` is placed in <body> AFTER the policy, so it can only ever narrow it further. */
export function inertPreviewDocument(title: string, html: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${INERT_PREVIEW_CSP}"><meta charset="utf-8"><title>${escapeText(title)}</title></head><body>${html}</body></html>`;
}

/**
 * The only approved way to show mail HTML in the console: an iframe with an empty `sandbox` (no scripts, opaque
 * origin, no forms, no top navigation), no referrer and a restrictive policy. The frame is structure-only (the
 * inherited `style-src 'self'` and the projection remove styling), so it is labelled "Structure preview".
 */
export function InertMailPreview({ title, html, text, height = "md" }: InertMailPreviewProps) {
  const textView = (
    <pre tabIndex={0} aria-label={`${title}, plain text`} className={cn("overflow-auto rounded-[var(--radius-card)] border border-line bg-surface-sunken p-4 font-mono text-sm break-words whitespace-pre-wrap text-body", heights[height])}>
      {text}
    </pre>
  );
  if (!html) return textView;
  return (
    <Tabs
      label={`${title}: view`}
      items={[
        {
          value: "structure",
          label: "Structure preview",
          content: (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted">Shows the message structure only. Images, link targets and styling are not loaded.</p>
              <iframe
                title={title}
                sandbox=""
                referrerPolicy="no-referrer"
                srcDoc={inertPreviewDocument(title, html)}
                className={cn("w-full rounded-[var(--radius-card)] border border-line bg-surface", heights[height])}
              />
            </div>
          ),
        },
        { value: "text", label: "Plain text", content: textView },
      ]}
    />
  );
}
