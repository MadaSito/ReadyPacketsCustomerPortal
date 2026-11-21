import { Suspense, lazy } from "react";
import { Skeleton } from "./Feedback";
import type { RichTextEditorProps } from "./editor/types";

export type { EditorVariable, RichTextEditorProps } from "./editor/types";
export { isAllowedHref as isAllowedMailHref, isAllowedImageSrc as isAllowedMailImageSrc } from "./editor/html";

const Impl = lazy(() => import("./editor/RichTextEditorImpl"));

/** HTML e-mail body editor (headings, bold / italic, lists, links, images by https URL, buttons, variable chips). */
export function RichTextEditor(props: RichTextEditorProps) {
  return (
    <Suspense
      fallback={
        <div role="status" aria-label={`${props.label}: loading editor`} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-56 w-full rounded-[var(--radius-control)]" />
        </div>
      }
    >
      <Impl {...props} />
    </Suspense>
  );
}
