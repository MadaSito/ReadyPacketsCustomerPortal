/**
 * Server quote for the current selection (`orders.quote`). Amounts shown to the customer come only from here.
 * Keeps the previous quote on screen while a new one loads (reported as pending) and never retries on the
 * server's validation answers.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import type { OrderQuote } from "./types";

export interface OrderQuoteState {
  quote: OrderQuote | null;
  pending: boolean;
  error: unknown;
}

export function useOrderQuote(items: ReadonlyArray<{ productPublicId: string; quantity: number }>): OrderQuoteState {
  const trpc = useTRPC();
  const enabled = items.length > 0;
  const input = { items: items.map((item) => ({ productPublicId: item.productPublicId, quantity: item.quantity })) };
  const query = useQuery({
    ...trpc.orders.quote.queryOptions(input, { enabled, placeholderData: keepPreviousData, staleTime: 30_000, retry: false }),
  });
  if (!enabled) return { quote: null, pending: false, error: null };
  return { quote: query.error ? null : (query.data ?? null), pending: query.isFetching || query.isPlaceholderData, error: query.error };
}
