/** Shared access probes: explicit router catalogue, including nested bulk inputs the generic sweep cannot infer. */
import { ulid } from "../../server/core/ids.js";

export type TrashProbeTarget = { kind: "order" | "customer"; publicId: string; batchId: string };
interface TrashProbeFixture {
  target: TrashProbeTarget;
  secondTarget: TrashProbeTarget;
  livePublicId: string;
  movedByPublicId: string;
  orderPublicId: string;
  confirmation: string;
}

type TrashProbe = {
  kind: "query" | "mutation";
  input: () => unknown;
  alternateInputs?: () => unknown[];
  denial: { code: "FORBIDDEN"; reason: "CAPABILITY_NOT_GRANTED" };
};

export function trashAccessProbes(fixture: TrashProbeFixture): Record<string, TrashProbe> {
  const { target, secondTarget, livePublicId, movedByPublicId, orderPublicId, confirmation } = fixture;
  const denial = { code: "FORBIDDEN", reason: "CAPABILITY_NOT_GRANTED" } as const;
  const query = (input: () => unknown): TrashProbe => ({ kind: "query", input, denial });
  const mutation = (input: () => unknown, alternateInputs?: () => unknown[]): TrashProbe => ({
    kind: "mutation", input, ...(alternateInputs ? { alternateInputs } : {}), denial,
  });
  const key = (action: string) => `isolation-trash-${action}-${ulid()}`;
  const retention = { autoPurgeEnabled: true, orderDays: 7, customerDays: 30 };
  return {
    "trash.list": query(() => ({ kind: target.kind, sort: "movedAt", dir: "desc", limit: 10, movedByPublicId })),
    "trash.counts": query(() => undefined),
    "trash.movedByOptions": query(() => undefined),
    "trash.summarize": query(() => target),
    "trash.moveToTrash": mutation(() => ({ kind: target.kind, publicId: livePublicId, idempotencyKey: key("move") })),
    "trash.restore": mutation(
      () => ({ items: [target], idempotencyKey: key("restore") }),
      () => [{ items: [target, secondTarget], idempotencyKey: key("restore-bulk") }],
    ),
    "trash.purge": mutation(
      () => ({ items: [target], confirmation, idempotencyKey: key("purge") }),
      () => [{ items: [target, secondTarget], confirmation: "DELETE 2", idempotencyKey: key("purge-bulk") }],
    ),
    // No external store is needed: the existing item (and a valid-shaped run id) must be rejected before lookup.
    "trash.finishLeavingExternalCopies": mutation(() => ({
      ...target, runId: ulid(), targetOrderPublicId: orderPublicId, confirmation, idempotencyKey: key("finish"),
    })),
    "trash.settings.get": query(() => undefined),
    "trash.settings.preview": query(() => retention),
    "trash.settings.update": mutation(() => ({
      ...retention, expectedVersion: 1, reviewedDueCount: 0, confirmation: "DELETE 0", idempotencyKey: key("settings"),
    })),
  };
}
