/** Increment 07 package A: phase editor. Import from "@/ui/phases" (kept out of the main barrel; it is admin-only). */
export { PhaseEditor, type PhaseEditorProps, type PhaseDesignerView } from "./PhaseEditor";
export { PhaseForm, type PhaseFormProps, type PhaseSlotName, type PhaseSlotRenderer } from "./PhaseForm";
export { keyFromLabel, newStage, stageErrors, compactStage, type PhaseStatusOption } from "./model";
export type { PhaseSlotContext, PhaseSlotProps, PhaseActionsSlotValue, PhaseWebhookSlotValue, PhaseFileSyncSlotValue } from "./slotTypes";
