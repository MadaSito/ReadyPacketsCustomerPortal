/**
 * Same-origin module Web Worker for Mammoth `.docx` -> raw HTML conversion (Increment 06 D9).
 * Running Mammoth inside a dedicated Worker allows `worker.terminate()` to interrupt synchronous
 * parser stalls when `withConversionTimeout` triggers, while keeping `worker-src 'self'` CSP strict.
 */
import mammoth from "mammoth";

export interface DocxWorkerRequest {
  readonly id: number;
  readonly arrayBuffer: ArrayBuffer;
  readonly styleMap: string[];
}

export type DocxWorkerResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly rawHtml: string;
      readonly messages: Array<{ type: string; message: string }>;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly errorMessage: string;
    };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<DocxWorkerRequest>) => void) | null;
  postMessage: (message: DocxWorkerResponse) => void;
};

workerScope.onmessage = (event: MessageEvent<DocxWorkerRequest>) => {
  const { id, arrayBuffer, styleMap } = event.data;
  void mammoth
    .convertToHtml(
      { arrayBuffer },
      {
        styleMap,
        includeDefaultStyleMap: true,
        ...({ externalFileAccess: false } as Record<string, unknown>),
      },
    )
    .then((result) => {
      workerScope.postMessage({
        id,
        ok: true,
        rawHtml: result.value,
        messages: result.messages.map((m) => ({ type: m.type, message: m.message })),
      });
    })
    .catch((err: unknown) => {
      workerScope.postMessage({
        id,
        ok: false,
        errorMessage: err instanceof Error ? err.message : "Failed to parse Word document.",
      });
    });
};
