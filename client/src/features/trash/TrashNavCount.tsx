/** Count badge for the "Trash" console navigation entry (items in the trash). Owner: audit_engineer. Kept apart so the page stays lazy. */
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/ui";
import { useTrashApi } from "./api";

/** Nothing while loading, at zero, or on any error (fails silently; no retries, no spinner). */
export function TrashNavCount() {
  const api = useTrashApi();
  const counts = useQuery({ ...api.counts.queryOptions(), staleTime: 60_000, retry: false, refetchOnWindowFocus: false, throwOnError: false });
  const total = counts.data ? counts.data.orders + counts.data.customers : 0;
  if (!total) return null;
  return <Badge>{total}<span className="sr-only"> in the trash</span></Badge>;
}
