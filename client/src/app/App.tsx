/** Application root: providers → router (guards + shells) → analytics consent slot. */
import { AppProviders } from "./providers";
import { AppRouter } from "./AppRouter";
import { PwaUpdatePrompt } from "./PwaUpdatePrompt";
import { AnalyticsConsentSlot } from "./slots";

export function App() {
  return (
    <AppProviders>
      <AppRouter />
      <AnalyticsConsentSlot />
      <PwaUpdatePrompt />
    </AppProviders>
  );
}
