export type FlowTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface FlowNode {
  id: string;
  label: string;
  sublabel?: string;
  /** Small tag above the label, e.g. "Trigger", "Condition", "Action". */
  kind?: string;
  tone?: FlowTone;
  x: number;
  y: number;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export type FlowSelection = { type: "node" | "edge"; id: string } | null;

export interface FlowCanvasProps {
  /** Accessible name of the canvas, e.g. "Workflow canvas". */
  label: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  selected?: FlowSelection;
  onSelect?: (selection: FlowSelection) => void;
  /** Drag end or keyboard move; coordinates snapped to the 20 px grid. */
  onMove?: (id: string, x: number, y: number) => void;
  /** Drag from a handle to another node, or keyboard connect (C, then Enter on the target). */
  onConnect?: (from: string, to: string) => void;
  /** Delete / Backspace on the focused node or connection. */
  onDelete?: (selection: NonNullable<FlowSelection>) => void;
  /** No move / connect / delete. Selection, pan and zoom still work. */
  readOnly?: boolean;
  height?: "sm" | "md" | "lg";
}

export const FLOW_GRID = 20;
export const FLOW_HEIGHTS = { sm: "h-80", md: "h-[30rem]", lg: "h-[40rem]" } as const;

export function snap(value: number): number {
  return Math.round(value / FLOW_GRID) * FLOW_GRID;
}
