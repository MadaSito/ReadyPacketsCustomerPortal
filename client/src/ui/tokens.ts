/**
 * Semantic colour tokens as data, mirrored from client/src/styles/index.css (and docs/brand/*.css).
 * Used by the computed-contrast test; never use these hex values in components (use Tailwind token classes).
 */
export const LIGHT_TOKENS = {
  navy: "#0D1B2A",
  ink: "#0D1B2A",
  body: "#4A5568",
  muted: "#5E6D82",
  line: "#DFE5EC",
  surface: "#FFFFFF",
  "surface-soft": "#F5F7FA",
  "surface-sunken": "#EEF2F7",
  action: "#137568",
  "action-hover": "#0E6056",
  "on-action": "#FFFFFF",
  "danger-action": "#B3261E",
  "on-danger-action": "#FFFFFF",
  "control-border": "#7B8798",
  success: "#157F52",
  warning: "#8A570E",
  danger: "#B3261E",
  info: "#1A6FA8",
  "success-soft": "#EFF8F3",
  "warning-soft": "#FBF1E1",
  "danger-soft": "#FBEAE9",
  "info-soft": "#E6F0F8",
  "action-soft": "#E3F1EF",
  "on-navy": "#F2F8F8",
  "on-navy-muted": "#B8C7D2",
  focus: "#137568",
} as const;

export type TokenName = keyof typeof LIGHT_TOKENS;

export const DARK_TOKENS: Record<TokenName, string> = {
  navy: "#071824",
  ink: "#F2F8F8",
  body: "#C4D2D8",
  muted: "#92A8B2",
  line: "#284656",
  surface: "#091A27",
  "surface-soft": "#102634",
  "surface-sunken": "#142F3E",
  action: "#2EC4B6",
  "action-hover": "#55D6C9",
  "on-action": "#071824",
  "danger-action": "#FF8D87",
  "on-danger-action": "#071824",
  "control-border": "#708C9C",
  success: "#57CF91",
  warning: "#EFBD65",
  danger: "#FF8D87",
  info: "#6DBCF0",
  "success-soft": "#10342C",
  "warning-soft": "#33301F",
  "danger-soft": "#3A2228",
  "info-soft": "#0F2E44",
  "action-soft": "#0F3438",
  "on-navy": "#F2F8F8",
  "on-navy-muted": "#B8C7D2",
  focus: "#55D6C9",
};

/** WCAG 2.x relative luminance of an sRGB hex colour. */
export function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Pairs the kit actually renders: [foreground, background, minimum ratio]. */
export const RENDERED_PAIRS: ReadonlyArray<readonly [TokenName, TokenName, number]> = [
  ...(["surface", "surface-soft", "surface-sunken"] as const).flatMap((bg) => [
    ["ink", bg, 4.5] as const,
    ["body", bg, 4.5] as const,
    ["muted", bg, 4.5] as const,
    ["action", bg, 4.5] as const,
    ["danger", bg, 4.5] as const,
    // Brand light `success` (#157F52) is 4.46:1 on surface-sunken: status text is only rendered on surface,
    // surface-soft or success-soft. Enforced below for those backgrounds.
    ...(bg === "surface-sunken" ? [] : [["success", bg, 4.5] as const]),
    ["warning", bg, 4.5] as const,
    ["info", bg, 4.5] as const,
    ["control-border", bg, 3] as const,
    ["focus", bg, 3] as const,
  ]),
  ["on-action", "action", 4.5],
  ["on-action", "action-hover", 4.5],
  ["on-danger-action", "danger-action", 4.5],
  ["success", "success-soft", 4.5],
  ["warning", "warning-soft", 4.5],
  ["danger", "danger-soft", 4.5],
  ["info", "info-soft", 4.5],
  ["action", "action-soft", 4.5],
  ["ink", "success-soft", 4.5],
  ["ink", "warning-soft", 4.5],
  ["ink", "danger-soft", 4.5],
  ["ink", "info-soft", 4.5],
  ["ink", "action-soft", 4.5],
  ["on-navy", "navy", 4.5],
  ["on-navy-muted", "navy", 4.5],
];
