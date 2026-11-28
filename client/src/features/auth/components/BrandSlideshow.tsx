/**
 * Restrained sign-in showcase fed by platform.presentation (plain text + allowlisted same-origin images).
 * Safe built-in defaults (brand pillars) when the setting is empty or unavailable. Auto-advance only when
 * the administrator enabled it AND the visitor does not prefer reduced motion; always pausable (WCAG 2.2.2).
 */
import { PRESENTATION_QUERY_KEY } from "@/app/shell/common";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { BRAND, BRAND_PILLARS } from "@shared/brand";
import { useAuthApi, type PublicSlide } from "@/lib/authApi";
import { apiUrl, assetUrl } from "@/lib/runtime";
import { BrandLogo } from "@/ui";
import { cn } from "@/ui/cn";

export const DEFAULT_SLIDES: PublicSlide[] = BRAND_PILLARS.map((pillar) => ({ id: pillar.name.toLowerCase(), title: pillar.name, body: pillar.detail, image: null }));

export function slideImageUrl(url: string): string | null {
  if (url.startsWith("/api/platform/presentation/images/")) return apiUrl(url);
  if (url.startsWith("/brand/") && !url.includes("..")) return assetUrl(url);
  return null; // anything else is ignored (defence in depth; server allowlists too)
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

export function BrandSlideshow() {
  const api = useAuthApi();
  const presentation = useQuery({ queryKey: PRESENTATION_QUERY_KEY, queryFn: () => api.presentation(), staleTime: 5 * 60_000, retry: false });
  const slides = presentation.data?.slides.length ? presentation.data.slides : DEFAULT_SLIDES;
  const autoAllowed = Boolean(presentation.data?.slideshow.autoAdvance) && !prefersReducedMotion();
  const interval = Math.min(Math.max(presentation.data?.slideshow.intervalSeconds ?? 8, 5), 60) * 1000;
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const current = slides[index % slides.length]!;

  useEffect(() => {
    if (!autoAllowed || !playing || slides.length < 2) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % slides.length), interval);
    return () => window.clearInterval(timer);
  }, [autoAllowed, playing, slides.length, interval]);

  const image = current.image ? slideImageUrl(current.image.url) : null;
  const go = (delta: number) => setIndex((i) => (i + delta + slides.length) % slides.length);
  const navButton = "inline-flex size-11 items-center justify-center rounded-full border border-navy-border text-on-navy hover:bg-navy-elevated";

  return (
    <section aria-roledescription="carousel" aria-label="About ReadyPackets" className="relative flex w-full flex-col justify-between overflow-hidden bg-navy p-10 text-on-navy xl:p-14">
      <div aria-hidden="true" className="pointer-events-none absolute -top-32 -right-32 size-96 rounded-full bg-teal/10 blur-3xl" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-40 -left-24 size-[28rem] rounded-full bg-gold/10 blur-3xl" />
      <BrandLogo appearance="dark" lockup="square" className="relative w-56" />
      <div className="relative max-w-lg">
        <div aria-live={autoAllowed && playing ? "off" : "polite"} aria-atomic="true">
          <div role="group" aria-roledescription="slide" aria-label={`${(index % slides.length) + 1} of ${slides.length}`}>
            {image ? <img src={image} alt={current.image?.alt ?? ""} className="mb-8 max-h-56 w-auto rounded-xl object-contain" /> : null}
            <p className="text-sm font-semibold tracking-[0.16em] text-teal-light uppercase">{presentation.data?.slides.length ? "ReadyPackets" : "Our promise"}</p>
            <h2 className="mt-3 text-3xl font-semibold text-on-navy xl:text-4xl">{current.title}</h2>
            <p className="mt-4 text-lg leading-relaxed text-on-navy-muted">{current.body}</p>
          </div>
        </div>
        {slides.length > 1 ? (
          <div className="mt-10 flex items-center gap-3">
            <button type="button" className={navButton} aria-label="Previous slide" onClick={() => go(-1)}>
              <ChevronLeft aria-hidden="true" className="size-5" />
            </button>
            <button type="button" className={navButton} aria-label="Next slide" onClick={() => go(1)}>
              <ChevronRight aria-hidden="true" className="size-5" />
            </button>
            {autoAllowed ? (
              <button type="button" className={navButton} aria-label={playing ? "Pause slideshow" : "Play slideshow"} onClick={() => setPlaying((p) => !p)}>
                {playing ? <Pause aria-hidden="true" className="size-5" /> : <Play aria-hidden="true" className="size-5" />}
              </button>
            ) : null}
            <div className="ml-2 flex gap-2" aria-hidden="true">
              {slides.map((slide, i) => (
                <span key={slide.id} className={cn("h-1.5 rounded-full transition-all", i === index % slides.length ? "w-8 bg-teal-light" : "w-3 bg-navy-border")} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <p className="relative text-sm text-on-navy-muted">{presentation.data?.supportText || BRAND.tagline}</p>
    </section>
  );
}
