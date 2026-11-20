/**
 * After each client-side navigation: set the document title, move focus to the page's <h1> (fallback: <main>)
 * and announce the new page in a polite live region. The very first load keeps the browser's natural focus.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const AnnounceContext = createContext<(message: string) => void>(() => {});
let firstNavigation = true;

export function RouteAnnouncerProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  return (
    <AnnounceContext.Provider value={setMessage}>
      {children}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="route-announcer">
        {message}
      </div>
    </AnnounceContext.Provider>
  );
}

export const APP_NAME = "ReadyPackets";

export function documentTitle(title: string): string {
  return title ? `${title} · ${APP_NAME}` : `${APP_NAME} Customer Portal`;
}

/** Render inside <Suspense> AFTER the page component, so it runs once the page has mounted. */
export function RouteFocus({ title, path }: { title: string; path: string }) {
  const announce = useContext(AnnounceContext);
  useEffect(() => {
    document.title = documentTitle(title);
    if (firstNavigation) {
      firstNavigation = false;
      return;
    }
    const main = document.getElementById("main");
    const heading = main?.querySelector<HTMLElement>("h1") ?? document.querySelector<HTMLElement>("h1");
    const target = heading ?? main;
    if (target) {
      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: false });
    }
    window.scrollTo?.({ top: 0 });
    announce(`${title || "Page"} loaded`);
  }, [title, path, announce]);
  return null;
}

/** Test hook: make the next navigation behave like a subsequent one. */
export function __resetRouteFocusForTests(first = false) {
  firstNavigation = first;
}
