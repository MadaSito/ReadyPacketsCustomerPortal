/**
 * ReadyPackets Document-Stack full lockup (brand package 2026.10.15.2, increment 09 D3). One supplied image,
 * never recoloured, redrawn, re-typeset or CSS-filtered:
 * - `lockup="square"` (default): square full lockup for tiles, auth, public/legal, error and launch surfaces.
 * - `lockup="horizontal"`: horizontal full lockup of the same package for narrow bars.
 * The light/dark file follows the resolved theme, or `appearance` when the surface is fixed (e.g. "dark" on
 * the navy side panels). In forced-colours mode the image keeps a backplate in its own surface colour so the
 * artwork stays legible whatever the system Canvas is (see .rp-brand-plate-* in styles/index.css).
 */
import { BRAND, BRAND_ASSETS } from "@shared/brand";
import { assetUrl } from "@/lib/runtime";
import { cn } from "./cn";
import { useTheme } from "./theme";

export const BRAND_LOGO_LABEL = BRAND.logoAccessibleName;

export type BrandLockup = "square" | "horizontal";

export interface BrandLogoProps {
  /** "auto" follows the resolved theme; "dark" = artwork for dark (navy) surfaces. */
  appearance?: "auto" | "light" | "dark";
  /** "square" full lockup (default) or the "horizontal" full lockup for narrow bars. */
  lockup?: BrandLockup;
  /** Accessible name (alt text); pass "" when a parent link already names it or the logo is a duplicate. */
  label?: string;
  className?: string;
}

export function BrandLogo({ appearance = "auto", lockup = "square", label = BRAND_LOGO_LABEL, className }: BrandLogoProps) {
  const { resolved } = useTheme();
  const tone = appearance === "auto" ? resolved : appearance;
  const image = BRAND_ASSETS[tone][lockup];
  return (
    <img
      src={assetUrl(image.path)}
      alt={label}
      width={image.width}
      height={image.height}
      draggable={false}
      decoding="async"
      data-brand-lockup={lockup}
      data-brand-tone={tone}
      className={cn(
        "block h-auto max-w-full select-none",
        tone === "dark" ? "rp-brand-plate-dark" : "rp-brand-plate-light",
        // Kept for existing selectors: dark artwork on a navy panel.
        tone === "dark" && "rp-brand-on-dark",
        className,
      )}
    />
  );
}
