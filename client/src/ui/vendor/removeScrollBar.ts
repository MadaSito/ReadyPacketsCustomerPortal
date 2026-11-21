/**
 * CSP-safe replacement for `react-remove-scroll-bar`.
 *
 * The upstream package (pulled in by Radix dialogs through `react-remove-scroll`) injects a `<style>` element at
 * runtime. Our Content-Security-Policy is `style-src 'self'` with no nonce and no `unsafe-inline`, so the browser
 * refuses that element: the page behind an open dialog stays scrollable and every dialog logs a CSP violation.
 *
 * This module keeps the same public surface but never creates a style element. It only sets the
 * `data-scroll-locked` attribute and one custom property through the CSSOM (both allowed under the policy); the
 * rules themselves live in `client/src/styles/index.css`. Wired in through the bundler alias in `vite.config.ts`.
 */
import { useEffect } from "react";

export const zeroRightClassName = "right-scroll-bar-position";
export const fullWidthClassName = "width-before-scroll-bar";
export const noScrollbarsClassName = "with-scroll-bars-hidden";
export const removedBarSizeVariable = "--removed-body-scroll-bar-size";

const LOCK_ATTRIBUTE = "data-scroll-locked";

export interface GapOffset {
  left: number;
  top: number;
  right: number;
  gap: number;
}

export function getGapWidth(): GapOffset {
  if (typeof window === "undefined") return { left: 0, top: 0, right: 0, gap: 0 };
  return { left: 0, top: 0, right: 0, gap: Math.max(0, window.innerWidth - document.documentElement.clientWidth) };
}

function lockCount(): number {
  const n = Number.parseInt(document.body.getAttribute(LOCK_ATTRIBUTE) ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
}

/** Blocks page scroll while mounted. Nested locks are counted, exactly like the upstream component. */
export function RemoveScrollBar(_props: { noRelative?: boolean; noImportant?: boolean; gapMode?: "padding" | "margin" }): null {
  useEffect(() => {
    const before = lockCount();
    if (before === 0) {
      // Measure before locking: once overflow is hidden the scrollbar (and therefore the gap) is gone.
      document.body.style.setProperty(removedBarSizeVariable, `${getGapWidth().gap}px`);
    }
    document.body.setAttribute(LOCK_ATTRIBUTE, String(before + 1));
    return () => {
      const after = lockCount() - 1;
      if (after <= 0) {
        document.body.removeAttribute(LOCK_ATTRIBUTE);
        document.body.style.removeProperty(removedBarSizeVariable);
      } else {
        document.body.setAttribute(LOCK_ATTRIBUTE, String(after));
      }
    };
  }, []);
  return null;
}
