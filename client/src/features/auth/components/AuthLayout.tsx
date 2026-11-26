/**
 * Auth/transition layout. Desktop (≥ lg): restrained brand slideshow on the LEFT, controls on the RIGHT.
 * Mobile: form first; a compact brand header above it, no slideshow.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "wouter";
import { BrandLogo, ThemeControl } from "@/ui";
import { cn } from "@/ui/cn";
import { ThemeToggle } from "@/app/shell/common";
import { BrandSlideshow } from "./BrandSlideshow";

export interface AuthLayoutProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Content under the card (e.g. "Create an account" link). */
  below?: ReactNode;
  /** Show the brand slideshow panel on desktop (sign-in/register). Transition screens use the plain variant. */
  showcase?: boolean;
  /** Wider card for content-heavy screens (MFA enrolment, recovery codes). */
  wide?: boolean;
  /** Move focus to the page heading on mount (e.g. a success screen that replaced a submitted form). */
  focusTitle?: boolean;
}

export function AuthLayout({ title, description, children, below, showcase = false, wide = false, focusTitle = false }: AuthLayoutProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusTitle) titleRef.current?.focus();
  }, [focusTitle]);
  return (
    <div className={cn("flex flex-1", showcase && "lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]")}>
      {showcase ? (
        <div className="hidden lg:flex">
          <BrandSlideshow />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 px-4 pt-4 sm:px-8 sm:pt-6">
          <Link href="/sign-in" aria-label="ReadyPackets sign in" className={cn("inline-flex rounded", showcase && "lg:invisible")}>
            <BrandLogo label="" className="w-44 sm:w-52" />
          </Link>
          <ThemeControl className="hidden sm:inline-flex" />
          <ThemeToggle className="sm:hidden" />
        </div>
        <div className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:px-8 sm:py-12">
          <div className={cn("w-full", wide ? "max-w-2xl" : "max-w-md")}>
            <div className="rounded-2xl border border-line bg-surface p-6 shadow-[var(--shadow-raised)] sm:p-8 rp-forced-border">
              <h1 ref={titleRef} tabIndex={focusTitle ? -1 : undefined} className="text-2xl font-semibold tracking-tight text-ink outline-none">{title}</h1>
              {description ? <div className="mt-2 text-[0.9375rem] text-body">{description}</div> : null}
              <div className="mt-6">{children}</div>
            </div>
            {below ? <div className="mt-6 text-center text-sm text-body">{below}</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
