/**
 * D3/D4 compact progress for the customer order list and the dashboard (package E, audit_engineer).
 * Takes the list-row fields published by orders (`progressPercent`, `phaseLabel`, `phaseIndex`, `phaseTotal`).
 * Rows without a phase model (null values) show nothing, so old data never shows a misleading bar.
 */
import { OrderProgress, type OrderProgressStage } from "@/ui";

export interface OrderListProgressProps {
  /** Order name, so each bar has its own accessible name in a list. */
  name: string;
  progressPercent: number | null | undefined;
  phaseLabel: string | null | undefined;
  /** 0-based; null or -1 when no phase is current. */
  phaseIndex: number | null | undefined;
  phaseTotal: number | null | undefined;
  canceled?: boolean;
  className?: string;
}

/** Stepper entries the compact bar needs: only the count and the current label are shown. */
export function listStages(phaseLabel: string | null | undefined, phaseIndex: number, phaseTotal: number): OrderProgressStage[] {
  return Array.from({ length: phaseTotal }, (_, i) => ({ key: `phase_${i}`, label: i === phaseIndex && phaseLabel ? phaseLabel : `Phase ${i + 1}` }));
}

export function OrderListProgress({ name, progressPercent, phaseLabel, phaseIndex, phaseTotal, canceled, className }: OrderListProgressProps) {
  if (progressPercent === null || progressPercent === undefined) return null;
  const total = Math.max(0, phaseTotal ?? 0);
  const index = phaseIndex !== null && phaseIndex !== undefined && phaseIndex < total ? phaseIndex : -1;
  return (
    <OrderProgress
      variant="compact"
      caption={null}
      label={`Progress of ${name}`}
      percent={progressPercent}
      stages={listStages(phaseLabel, index, total)}
      currentIndex={index}
      canceled={canceled}
      className={className}
    />
  );
}
