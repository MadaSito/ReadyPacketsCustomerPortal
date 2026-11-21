/**
 * FlowCanvas implementation on @xyflow/react (lazy chunk). CSP: the library renders positions through React style
 * props (CSSOM, not governed by `style-src`) and creates no <style> elements; its static CSS is imported here and
 * bundled as a same-origin stylesheet.
 */
import "@xyflow/react/dist/base.css";
import "./flow.css";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getSmoothStepPath,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Maximize, Minus, Plus } from "lucide-react";
import { createContext, useEffect, useCallback, useContext, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button, IconButton } from "../Button";
import { cn } from "../cn";
import { arrangeFlow, FLOW_GRID, FLOW_HEIGHTS, snap, type FlowCanvasProps, type FlowEdge, type FlowNode, type FlowSelection, type FlowTone } from "./types";

type RpNode = Node<{ node: FlowNode }, "rp">;
type RpEdge = Edge<{ edge: FlowEdge; fromLabel: string; toLabel: string }, "rp">;

interface CanvasApi {
  readOnly: boolean;
  connectFrom: string | null;
  helpId: string;
  canMove: boolean;
  canConnect: boolean;
  select: (selection: FlowSelection) => void;
  nodeKey: (event: KeyboardEvent<HTMLButtonElement>, node: FlowNode) => void;
  edgeKey: (event: KeyboardEvent<HTMLButtonElement>, edge: FlowEdge) => void;
  reveal: (element: HTMLElement) => void;
}
const CanvasContext = createContext<CanvasApi | null>(null);
function useCanvas(): CanvasApi {
  const api = useContext(CanvasContext);
  if (!api) throw new Error("FlowCanvas context missing");
  return api;
}

const toneBar: Record<FlowTone, string> = {
  neutral: "border-l-control-border",
  info: "border-l-info",
  success: "border-l-success",
  warning: "border-l-warning",
  danger: "border-l-danger",
};

function NodeCard({ id, data, selected }: NodeProps<RpNode>) {
  const api = useCanvas();
  const node = data.node;
  const connecting = api.connectFrom === id;
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={api.canConnect} className="rp-flow-handle" />
      <button
        type="button"
        data-flow-node={id}
        aria-label={`${node.kind ? `${node.kind}: ` : ""}${node.label}${node.sublabel ? `, ${node.sublabel}` : ""}${connecting ? ", connecting from this step" : ""}`}
        aria-pressed={selected ? "true" : "false"}
        aria-describedby={api.helpId}
        onClick={() => api.select({ type: "node", id })}
        onKeyDown={(event) => api.nodeKey(event, node)}
        onFocus={(event) => api.reveal(event.currentTarget)}
        className={cn(
          "flex w-52 min-w-0 flex-col items-start gap-0.5 rounded-[var(--radius-card)] border border-l-4 border-line bg-surface px-3 py-2 text-left shadow-[var(--shadow-card)]",
          toneBar[node.tone ?? "neutral"],
          selected && "ring-2 ring-action ring-offset-2 ring-offset-surface",
          connecting && "outline-2 outline-offset-4 outline-dashed outline-action",
        )}
      >
        {node.kind ? <span className="text-xs font-semibold tracking-wide text-muted uppercase">{node.kind}</span> : null}
        <span className="w-full font-semibold break-words text-ink">{node.label}</span>
        {node.sublabel ? <span className="w-full text-sm break-words text-muted">{node.sublabel}</span> : null}
      </button>
      <Handle type="source" position={Position.Right} isConnectable={api.canConnect} className="rp-flow-handle" />
    </>
  );
}

function EdgeLine(props: EdgeProps<RpEdge>) {
  const api = useCanvas();
  const { id, data, selected, markerEnd } = props;
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
  });
  if (!data) return <BaseEdge id={id} path={path} markerEnd={markerEnd} />;
  const name = `${data.edge.label ? `${data.edge.label}: ` : ""}from ${data.fromLabel} to ${data.toLabel}`;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <button
          type="button"
          aria-label={name}
          aria-pressed={selected ? "true" : "false"}
          aria-describedby={api.helpId}
          onClick={() => api.select({ type: "edge", id })}
          onKeyDown={(event) => api.edgeKey(event, data.edge)}
          onFocus={(event) => api.reveal(event.currentTarget)}
          // Position only (CSSOM; allowed under style-src 'self').
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          className={cn(
            "nodrag nopan pointer-events-auto absolute flex min-h-8 min-w-8 max-w-48 items-center justify-center rounded-full border border-line bg-surface px-2 text-xs font-medium text-body",
            selected && "border-action text-ink ring-2 ring-action",
          )}
        >
          <span className="truncate">{data.edge.label ?? <span aria-hidden="true">•</span>}</span>
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { rp: NodeCard };
const edgeTypes = { rp: EdgeLine };
const INSTANT = { duration: 0 } as const;
// @xyflow/react 13 reads a bare number as pixels (0.2 → 0 px), so the margin is given as a percentage.
const FIT = { padding: "8%", maxZoom: 1 } as const;

function Canvas({ label, nodes, edges, selected = null, onSelect, onMove, onConnect, onArrange, onDelete, readOnly = false, height = "md" }: FlowCanvasProps) {
  const flow = useReactFlow<RpNode, RpEdge>();
  const helpId = useId();
  const frameRef = useRef<HTMLDivElement>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const canMove = !readOnly && !!onMove;
  const canConnect = !readOnly && !!onConnect;
  const canDelete = !readOnly && !!onDelete;

  const labels = useMemo(() => new Map(nodes.map((node) => [node.id, node.label])), [nodes]);

  // Keyboard moves can change the reading order (nodes are sorted top-to-bottom, left-to-right). The browser
  // drops focus when the focused element is re-inserted, so put it back on the step that was just moved.
  const refocusNode = useRef<string | null>(null);
  useEffect(() => {
    const id = refocusNode.current;
    if (!id) return;
    const frame = window.requestAnimationFrame(() => {
      refocusNode.current = null;
      const target = [...(frameRef.current?.querySelectorAll<HTMLElement>("[data-flow-node]") ?? [])]
        .find((element) => element.dataset.flowNode === id);
      if (target && document.activeElement !== target) target.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [nodes]);

  const rfNodes = useMemo<RpNode[]>(
    () =>
      [...nodes]
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((node) => ({
          id: node.id,
          type: "rp",
          position: { x: node.x, y: node.y },
          data: { node },
          selected: selected?.type === "node" && selected.id === node.id,
          draggable: canMove,
          connectable: canConnect,
          selectable: false,
          focusable: false,
        })),
    [nodes, selected, canMove, canConnect],
  );
  // Controlled positions, but drags must render live: keep transient positions locally until drag stop.
  const [dragging, setDragging] = useState<Record<string, { x: number; y: number }>>({});
  const shownNodes = useMemo<RpNode[]>(
    () =>
      rfNodes.map((node) => {
        const live = dragging[node.id];
        return live ? { ...node, position: live } : node;
      }),
    [rfNodes, dragging],
  );

  const rfEdges = useMemo<RpEdge[]>(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        type: "rp",
        source: edge.from,
        target: edge.to,
        data: { edge, fromLabel: labels.get(edge.from) ?? edge.from, toLabel: labels.get(edge.to) ?? edge.to },
        ariaLabel: `${edge.label ? `${edge.label}: ` : ""}from ${labels.get(edge.from) ?? edge.from} to ${labels.get(edge.to) ?? edge.to}`,
        selected: selected?.type === "edge" && selected.id === edge.id,
        selectable: false,
        focusable: false,
        markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
      })),
    [edges, labels, selected],
  );

  const select = useCallback((selection: FlowSelection) => onSelect?.(selection), [onSelect]);

  const reveal = useCallback(
    (element: HTMLElement) => {
      const frame = frameRef.current;
      if (!frame) return;
      const box = frame.getBoundingClientRect();
      const item = element.getBoundingClientRect();
      const pad = 24;
      let dx = 0;
      let dy = 0;
      if (item.left < box.left + pad) dx = box.left + pad - item.left;
      else if (item.right > box.right - pad) dx = box.right - pad - item.right;
      if (item.top < box.top + pad) dy = box.top + pad - item.top;
      else if (item.bottom > box.bottom - pad) dy = box.bottom - pad - item.bottom;
      if (dx === 0 && dy === 0) return;
      const view = flow.getViewport();
      void flow.setViewport({ x: view.x + dx, y: view.y + dy, zoom: view.zoom }, INSTANT);
    },
    [flow],
  );

  const nodeKey = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, node: FlowNode) => {
      const key = event.key;
      if (connectFrom) {
        if (key === "Escape") {
          event.preventDefault();
          setConnectFrom(null);
          setMessage("Connecting cancelled.");
          return;
        }
        if ((key === "Enter" || key === " ") && connectFrom !== node.id) {
          event.preventDefault();
          onConnect?.(connectFrom, node.id);
          setMessage(`Connected ${labels.get(connectFrom) ?? connectFrom} to ${node.label}.`);
          setConnectFrom(null);
          return;
        }
      }
      if (key.startsWith("Arrow") && canMove) {
        event.preventDefault();
        const step = event.shiftKey ? FLOW_GRID * 5 : FLOW_GRID;
        const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
        const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
        const x = snap(node.x + dx);
        const y = snap(node.y + dy);
        refocusNode.current = node.id;
        onMove?.(node.id, x, y);
        select({ type: "node", id: node.id });
        setMessage(`Moved ${node.label} to ${x}, ${y}.`);
        return;
      }
      if ((key === "c" || key === "C") && canConnect && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setConnectFrom(node.id);
        setMessage(`Connecting from ${node.label}. Tab to the target step and press Enter. Escape cancels.`);
        return;
      }
      if ((key === "Delete" || key === "Backspace") && canDelete) {
        event.preventDefault();
        onDelete?.({ type: "node", id: node.id });
        setMessage(`Deleted ${node.label}.`);
        return;
      }
      if (key === "Escape" && selected) {
        event.preventDefault();
        select(null);
      }
    },
    [connectFrom, canMove, canConnect, canDelete, onConnect, onMove, onDelete, labels, select, selected],
  );

  const edgeKey = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, edge: FlowEdge) => {
      if ((event.key === "Delete" || event.key === "Backspace") && canDelete) {
        event.preventDefault();
        onDelete?.({ type: "edge", id: edge.id });
        setMessage(`Deleted the connection from ${labels.get(edge.from) ?? edge.from} to ${labels.get(edge.to) ?? edge.to}.`);
      } else if (event.key === "Escape" && selected) {
        event.preventDefault();
        select(null);
      }
    },
    [canDelete, onDelete, labels, select, selected],
  );

  const api = useMemo<CanvasApi>(
    () => ({ readOnly, connectFrom, helpId, canMove, canConnect, select, nodeKey, edgeKey, reveal }),
    [readOnly, connectFrom, helpId, canMove, canConnect, select, nodeKey, edgeKey, reveal],
  );

  const help = [
    "Tab moves between connections and steps; Enter selects.",
    canMove ? "Arrow keys move a step (Shift for larger steps)." : null,
    canConnect ? "C starts a connection; then Enter on the target step, Escape cancels." : null,
    canDelete ? "Delete removes the focused item." : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <CanvasContext.Provider value={api}>
      <div role="group" aria-label={label} className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1">
          <IconButton label="Zoom in" icon={<Plus />} variant="secondary" size="sm" onClick={() => void flow.zoomIn(INSTANT)} />
          <IconButton label="Zoom out" icon={<Minus />} variant="secondary" size="sm" onClick={() => void flow.zoomOut(INSTANT)} />
          <IconButton label="Fit to view" icon={<Maximize />} variant="secondary" size="sm" onClick={() => void flow.fitView({ ...INSTANT, ...FIT })} />
          {!readOnly && onArrange ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                onArrange(arrangeFlow(nodes, edges));
                setMessage("Steps arranged from left to right.");
                // Fit once the new positions have rendered.
                window.setTimeout(() => void flow.fitView({ ...INSTANT, ...FIT }), 60);
              }}
            >
              Tidy layout
            </Button>
          ) : null}
          {readOnly ? <span className="ml-2 text-sm text-muted">Read only</span> : null}
        </div>
        <p id={helpId} className="text-sm text-muted">
          {help}
        </p>
        <div ref={frameRef} className={cn("rp-flow min-w-0 max-h-[70vh] overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface-soft", FLOW_HEIGHTS[height])}>
          <ReactFlow<RpNode, RpEdge>
            nodes={shownNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={(changes) => {
              for (const change of changes) {
                if (change.type === "position" && change.dragging && change.position) {
                  const position = change.position;
                  setDragging((prev) => ({ ...prev, [change.id]: position }));
                }
              }
            }}
            onNodeDragStop={(_event, node) => {
              setDragging((prev) => {
                const next = { ...prev };
                delete next[node.id];
                return next;
              });
              const x = snap(node.position.x);
              const y = snap(node.position.y);
              onMove?.(node.id, x, y);
              setMessage(`Moved ${node.data.node.label} to ${x}, ${y}.`);
            }}
            onConnect={(connection: Connection) => {
              if (connection.source && connection.target && connection.source !== connection.target) onConnect?.(connection.source, connection.target);
            }}
            // Also keeps pointer events on read-only nodes (the library disables them for inert nodes).
            onNodeClick={(_event, node) => select({ type: "node", id: node.id })}
            onPaneClick={() => select(null)}
            nodesDraggable={canMove}
            nodesConnectable={canConnect}
            nodesFocusable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            disableKeyboardA11y
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            snapToGrid
            snapGrid={[FLOW_GRID, FLOW_GRID]}
            zoomOnDoubleClick={false}
            minZoom={0.25}
            maxZoom={2}
            fitView
            fitViewOptions={FIT}
            proOptions={{ hideAttribution: true }}
          />
        </div>
        <p aria-live="polite" className="sr-only">
          {message}
        </p>
      </div>
    </CanvasContext.Provider>
  );
}

export default function FlowCanvasImpl(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
