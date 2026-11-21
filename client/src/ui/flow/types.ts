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
  /**
   * "Tidy layout" button: receives a left-to-right arrangement for every step (see `arrangeFlow`).
   * Omit to hide the button. Applied in one call so callers can make it a single edit.
   */
  onArrange?: (positions: Record<string, { x: number; y: number }>) => void;
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

const ARRANGE_COLUMN = 320;
const ARRANGE_ROW = 140;

/**
 * Left-to-right layered arrangement: a step sits one column after the nearest step that leads to it, so the
 * diagram reads from the start on the left. Loops back to an earlier step do not move that step. Steps keep
 * their given order within a column; steps nothing leads to that are not starting points go in the last column.
 */
export function arrangeFlow(nodes: readonly Pick<FlowNode, "id">[], edges: readonly Pick<FlowEdge, "from" | "to">[]): Record<string, { x: number; y: number }> {
  const ids = nodes.map((node) => node.id);
  const known = new Set(ids);
  const next = new Map<string, string[]>();
  const hasIncoming = new Set<string>();
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to) continue;
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
    hasIncoming.add(edge.to);
  }
  const column = new Map<string, number>();
  const roots = ids.filter((id) => !hasIncoming.has(id));
  const queue = roots.length > 0 ? [...roots] : ids.slice(0, 1);
  for (const id of queue) column.set(id, 0);
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i]!;
    for (const target of next.get(id) ?? []) {
      if (column.has(target)) continue;
      column.set(target, column.get(id)! + 1);
      queue.push(target);
    }
  }
  const last = Math.max(0, ...column.values());
  const columns = new Map<number, string[]>();
  for (const id of ids) {
    const at = column.get(id) ?? last + 1;
    columns.set(at, [...(columns.get(at) ?? []), id]);
  }
  const tallest = Math.max(1, ...[...columns.values()].map((list) => list.length));
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [at, list] of columns) {
    const offset = ((tallest - list.length) * ARRANGE_ROW) / 2;
    list.forEach((id, row) => {
      positions[id] = { x: snap(at * ARRANGE_COLUMN), y: snap(offset + row * ARRANGE_ROW) };
    });
  }
  return positions;
}
