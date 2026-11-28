/**
 * Shared e-mail address link (increment 09 D1). Renders a `mailto:` link for a plain address shown as contact
 * information or as a person's address. Long addresses wrap anywhere, the link is always underlined (no
 * colour-only cue) and uses the global visible focus ring. A value that is not a plain address (spaces, header
 * characters such as `?`, `&` or line breaks) is shown as text, never as a link, so no mail header can be injected.
 */
import type { ReactNode } from "react";
import { cn } from "./cn";

const MAX_EMAIL_LENGTH = 254;
// One "@" with no whitespace, mailto header characters, quotes, angle brackets, backslashes or controls on
// either side. Two character classes around a literal: linear, no backtracking.
// eslint-disable-next-line no-control-regex
const PLAIN_ADDRESS = /^[^\s@?#&%<>"'`\\,;:()[\]\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+@[^\s@?#&%<>"'`\\,;:()[\]\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+$/u;

/** The `mailto:` href for a plain address, or null when the value must not become a link. */
export function mailtoHref(email: string): string | null {
  const value = email.trim();
  if (value.length === 0 || value.length > MAX_EMAIL_LENGTH || !PLAIN_ADDRESS.test(value)) return null;
  const [local, domain] = value.split("@") as [string, string];
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return null;
  return `mailto:${local}@${domain}`;
}

export interface EmailLinkProps {
  email: string;
  /** Visible text; defaults to the address itself. */
  children?: ReactNode;
  className?: string;
  /** Extra accessible context, e.g. "Email Zeus Greene". Defaults to the visible text. */
  label?: string;
}

export function EmailLink({ email, children, className, label }: EmailLinkProps) {
  const href = mailtoHref(email);
  const text = children ?? email.trim();
  const wrap = "[overflow-wrap:anywhere] break-words";
  if (!href) return <span className={cn(wrap, className)}>{text}</span>;
  return (
    <a
      href={href}
      aria-label={label}
      data-rp-email-link=""
      className={cn("rounded-sm text-action underline underline-offset-2 hover:text-action-hover", wrap, className)}
    >
      {text}
    </a>
  );
}
