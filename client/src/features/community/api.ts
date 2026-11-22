/** Typed tRPC bridge for `trpc.community.*` (server/modules/community/API.md). Owner: audit_engineer. */
import { useTRPC } from "@/lib/trpc";

export function useCommunityApi() {
  return useTRPC().community;
}

export type {
  CategoryView,
  CommunityStatusView,
  ModerationLogView,
  PostView,
  QueueView,
  ReportView,
  TopicDetailView,
  TopicSummaryView,
} from "@server/modules/community/service";
export type { CommunityConfig } from "@server/modules/community/settings";

/** Random idempotency key for create/reply (server accepts [A-Za-z0-9_-]{8,64}). */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
