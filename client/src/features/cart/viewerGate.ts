import { useIsStaffViewer } from "@/app/portal";
import { useSession } from "@/lib/session";

/**
 * Shared viewer role check for customer cart & checkout surfaces (Increment 07.1, D4).
 *
 * - In production, `RouteGate` resolves `useSession()` before mounting any customer shell or page, so `pending`
 *   is immediately `false` on first render.
 * - When a component is mounted directly in tests with an async `AuthApi.me` stub, `pending` stays `true` for the
 *   initial microtask (`failureCount === 0`) so staff/admin renders never fire `trpc.cart.*` queries before `me`
 *   settles, while unstubbed test harnesses (`fakeAuthApi.me` rejecting on tick 1 -> `failureCount > 0`) proceed
 *   immediately without waiting on `useSession()`'s retry backoff.
 */
export function useCartViewerGate(): { pending: boolean; staffViewer: boolean } {
  const { view, query } = useSession();
  const staffViewer = useIsStaffViewer();
  const pending = view.status === "loading" && query.failureCount === 0;
  return { pending, staffViewer };
}
