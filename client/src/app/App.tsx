/** Application root: providers → router (guards + shells) → analytics consent slot. */
import { AppProviders } from "./providers";
import { AppRouter } from "./AppRouter";
import { AnalyticsConsentSlot } from "./slots";

export function App() {
  return (
    <AppProviders>
      <AppRouter />
      <AnalyticsConsentSlot />
    </AppProviders>
  );
}
