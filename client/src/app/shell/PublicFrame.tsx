/** Frame for public and transition screens: skip link, maintenance banner, <main>, footer. Pages own their layout. */
import type { ReactNode } from "react";
import { Footer, MaintenanceBanner, SkipLink } from "./common";

export function PublicFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-surface-soft">
      <SkipLink />
      <MaintenanceBanner />
      <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
        {children}
      </main>
      <Footer />
    </div>
  );
}
