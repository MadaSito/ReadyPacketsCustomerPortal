/**
 * Settings declared by the platform module: sign-in presentation (slideshow, support text, announcement).
 * All presentation copy is bounded PLAIN TEXT: no markup characters, no control characters, NFC-normalized.
 * Images are either an allowlisted self-hosted brand asset or an image uploaded through the validated path.
 */
import { z } from "zod";
import { defineSetting } from "./settingsRegistry.js";

// eslint-disable-next-line no-control-regex -- deliberately matching control characters to refuse them
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/;
const MARKUP = /[<>`]|javascript:|data:|vbscript:/i;

/** Bounded plain text. `multiline` allows \n (and \r\n). */
export function plainText(max: number, options: { multiline?: boolean; min?: number } = {}) {
  return z
    .string()
    .max(max * 2)
    .transform((value) => value.normalize("NFC").replace(/\r\n/g, "\n").trim())
    .pipe(
      z
        .string()
        .min(options.min ?? 0)
        .max(max)
        .refine((value) => !CONTROL.test(value), "must not contain control characters")
        .refine((value) => options.multiline || !value.includes("\n"), "must be a single line")
        .refine((value) => !MARKUP.test(value), "must be plain text (no markup or script URLs)")
        .refine((value) => (value.match(/\n/g)?.length ?? 0) <= 12, "has too many lines"),
    );
}

/**
 * Reviewed, self-hosted images that may appear on the sign-in page. Paths are under client/public.
 * Adding an entry is a code change (review), never an admin action.
 */
export const BRAND_IMAGE_ALLOWLIST = {
  "brand-icon-light-512": { path: "/brand/readypackets-approved-icon-light-512.png", width: 512, height: 512 },
  "brand-icon-maskable-512": { path: "/brand/readypackets-approved-icon-maskable-512.png", width: 512, height: 512 },
} as const;
export type BrandImageId = keyof typeof BRAND_IMAGE_ALLOWLIST;
const BRAND_IDS = Object.keys(BRAND_IMAGE_ALLOWLIST) as [BrandImageId, ...BrandImageId[]];

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const slideImageSchema = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("brand"), id: z.enum(BRAND_IDS), alt: plainText(160) }),
  z.strictObject({ source: z.literal("upload"), id: z.string().regex(ULID_PATTERN), alt: plainText(160) }),
]);

export const slideSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,32}$/),
  title: plainText(80, { min: 1 }),
  body: plainText(280, { multiline: true }),
  image: slideImageSchema.nullable(),
});
export type Slide = z.infer<typeof slideSchema>;

export const MAX_SLIDES = 6;

export const slidesSchema = z
  .array(slideSchema)
  .max(MAX_SLIDES)
  .refine((slides) => new Set(slides.map((slide) => slide.id)).size === slides.length, "slide ids must be unique");

export const PRESENTATION_SLIDES = defineSetting({
  key: "platform.presentation.slides",
  owner: "platform",
  group: "presentation",
  label: "Sign-in slideshow",
  description: "Up to six plain-text slides shown beside the sign-in form on wide screens.",
  schema: slidesSchema,
  default: [
    {
      id: "welcome",
      title: "Welcome to ReadyPackets",
      body: "Sign in to see your orders, files and messages in one place.",
      image: null,
    },
  ],
  sensitivity: "public",
});

export const PRESENTATION_SLIDESHOW = defineSetting({
  key: "platform.presentation.slideshow",
  owner: "platform",
  group: "presentation",
  label: "Slideshow behaviour",
  description: "Automatic advance is off by default; visitors can always pause and navigate. Reduced-motion preferences disable it.",
  schema: z.strictObject({ autoAdvance: z.boolean(), intervalSeconds: z.number().int().min(6).max(30) }),
  default: { autoAdvance: false, intervalSeconds: 8 },
  sensitivity: "public",
});

export const PRESENTATION_SUPPORT_TEXT = defineSetting({
  key: "platform.presentation.support_text",
  owner: "platform",
  group: "presentation",
  label: "Support contact text",
  description: "Plain text shown on the sign-in page and in the help panel (for example, how to reach support).",
  schema: plainText(500, { multiline: true }),
  default: "",
  sensitivity: "public",
});

export const announcementSchema = z.strictObject({
  enabled: z.boolean(),
  text: plainText(280),
  tone: z.enum(["info", "warning"]),
});

export const PRESENTATION_ANNOUNCEMENT = defineSetting({
  key: "platform.presentation.announcement",
  owner: "platform",
  group: "presentation",
  label: "Announcement banner",
  description: "Optional single-line banner shown on the sign-in page and to signed-in users.",
  schema: announcementSchema.refine((value) => !value.enabled || value.text.length > 0, "an enabled banner needs text"),
  default: { enabled: false, text: "", tone: "info" as const },
  sensitivity: "public",
});

export const PRESENTATION_KEYS = [
  PRESENTATION_SLIDES.key,
  PRESENTATION_SLIDESHOW.key,
  PRESENTATION_SUPPORT_TEXT.key,
  PRESENTATION_ANNOUNCEMENT.key,
] as const;
