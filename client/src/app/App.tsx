/** Application root. Owner: UI foundation engineer — replace this placeholder with providers, router and shells. */
import { ALL_ROUTES } from "./registry";

export function App() {
  return (
    <main>
      <h1>ReadyPackets Customer Portal</h1>
      <p>{ALL_ROUTES.length} routes registered.</p>
    </main>
  );
}
