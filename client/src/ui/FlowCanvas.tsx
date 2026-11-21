import { Suspense, lazy } from "react";
import { cn } from "./cn";
import { Skeleton } from "./Feedback";
import { FLOW_HEIGHTS, type FlowCanvasProps } from "./flow/types";

export type { FlowCanvasProps, FlowEdge, FlowNode, FlowSelection, FlowTone } from "./flow/types";

const Impl = lazy(() => import("./flow/FlowCanvasImpl"));

/** Node / edge canvas (statuses and transitions, automation steps). Library code loads on first render. */
export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <Suspense
      fallback={
        <div role="status" aria-label={`${props.label}: loading`} className="flex flex-col gap-2">
          <Skeleton className={cn("w-full rounded-[var(--radius-card)]", FLOW_HEIGHTS[props.height ?? "md"])} />
        </div>
      }
    >
      <Impl {...props} />
    </Suspense>
  );
}
