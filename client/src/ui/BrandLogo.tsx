/**
 * Approved ReadyPackets lockup assembled from the four supplied PNG components (icon + wordmark/rule/tagline
 * stack) per docs/brand/BRAND_GUIDE.md §2. Never recolour, redraw or typeset the logo. The matching light/dark
 * set is chosen from the resolved theme or forced via `appearance` (e.g. "dark" on navy panels).
 */
import { BRAND_ASSETS } from "@shared/brand";
import { assetUrl } from "@/lib/runtime";
import { cn } from "./cn";
import { useTheme } from "./theme";

export const BRAND_LOGO_LABEL = "ReadyPackets\u2122 \u2014 Your Business, Professionally Packeted\u2122";

export interface BrandLogoProps {
  /** "auto" follows the theme; "dark" = artwork for dark backgrounds. */
  appearance?: "auto" | "light" | "dark";
  /** "full" lockup or the compact icon only. */
  variant?: "full" | "icon";
  /** Accessible label; pass "" when a parent link already names it. */
  label?: string;
  className?: string;
}

export function BrandLogo({ appearance = "auto", variant = "full", label = BRAND_LOGO_LABEL, className }: BrandLogoProps) {
  const { resolved } = useTheme();
  const set = BRAND_ASSETS[appearance === "auto" ? resolved : appearance];
  // Artwork for dark backgrounds keeps its navy backdrop in forced-colours mode (where panel backgrounds
  // become Canvas and the white wordmark would vanish). See .rp-brand-on-dark in styles/index.css.
  const onDark = appearance === "dark" && "rp-brand-on-dark";
  const groupProps = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
  if (variant === "icon") {
    return (
      <span {...groupProps} className={cn("inline-flex", onDark, className)}>
        <img src={assetUrl(set.icon)} alt="" className="h-full w-auto object-contain" draggable={false} />
      </span>
    );
  }
  return (
    <span {...groupProps} className={cn("inline-flex items-center gap-2", onDark, className)}>
      <img src={assetUrl(set.icon)} alt="" className="h-auto w-[18%] shrink-0" draggable={false} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <img src={assetUrl(set.wordmark)} alt="" className="h-auto w-full" draggable={false} />
        <img src={assetUrl(set.rule)} alt="" className="h-auto w-full" draggable={false} />
        <img src={assetUrl(set.tagline)} alt="" className="h-auto w-[95%]" draggable={false} />
      </span>
    </span>
  );
}
