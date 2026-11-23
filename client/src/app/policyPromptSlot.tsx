/**
 * Policy enforcement warning / block prompt (compliance, increment 06), mounted once in each full-session
 * shell. Kept out of slots.tsx so existing tests that mock "./slots" completely keep working. The compliance
 * component reads the current user and route itself; a missing module or a thrown error renders nothing.
 */
import { Component, Suspense, lazy, type ReactNode } from "react";

class PromptBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

const loader = Object.values(import.meta.glob<Record<string, unknown>>("../features/compliance/policyUpdates/PolicyEnforcementPrompt.tsx"))[0];
const PolicyPromptImpl = loader ? lazy(() => loader().then((m) => ({ default: m.PolicyEnforcementPrompt as () => ReactNode }))) : null;

export function PolicyPromptSlot() {
  if (!PolicyPromptImpl) return null;
  return (
    <PromptBoundary>
      <Suspense fallback={null}>
        <PolicyPromptImpl />
      </Suspense>
    </PromptBoundary>
  );
}
