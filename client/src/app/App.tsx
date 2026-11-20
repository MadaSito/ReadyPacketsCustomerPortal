/** Application root: providers → realm-taint boundary (INT-01) → router (guards + shells) → analytics consent slot. */
import { AppProviders } from "./providers";
import { AppRouter } from "./AppRouter";
import { PwaUpdatePrompt } from "./PwaUpdatePrompt";
import { RealmTaintBoundary } from "./RealmTaint";
import { AnalyticsConsentSlot } from "./slots";

export function App() {
  return (
    <AppProviders>
      <RealmTaintBoundary>
        <AppRouter />
      </RealmTaintBoundary>
      <AnalyticsConsentSlot />
      <PwaUpdatePrompt />
    </AppProviders>
  );
}
