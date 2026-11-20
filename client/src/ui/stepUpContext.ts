/**
 * Step-up context + pure helpers, split from StepUp.tsx so low-level kit pieces (Feedback's ErrorState) can
 * read it without an import cycle (StepUp.tsx imports Callout from Feedback).
 */
import { createContext, useContext } from "react";
import { safeError } from "@/lib/trpc";

export class StepUpCancelledError extends Error {
  constructor() {
    super("Step-up verification was cancelled.");
    this.name = "StepUpCancelledError";
  }
}

export function isStepUpRequired(error: unknown): boolean {
  return safeError(error)?.domainCode === "STEP_UP_REQUIRED";
}

export interface StepUpApi {
  /** Run an action, transparently handling one step-up round trip. */
  run: <T>(action: () => Promise<T>, options?: { reason?: string }) => Promise<T>;
  /** Ask for step-up proactively (before opening a sensitive screen). Resolves true when verified. */
  request: (options?: { reason?: string }) => Promise<boolean>;
}

export const StepUpContext = createContext<StepUpApi | null>(null);

/** The step-up API, or null when no StepUpProvider is mounted (kit pieces then degrade gracefully). */
export function useOptionalStepUp(): StepUpApi | null {
  return useContext(StepUpContext);
}
