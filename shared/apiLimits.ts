/**
 * Request-shape limits shared by the HTTP edge and the browser client.
 *
 * The server refuses a tRPC batch larger than `TRPC_MAX_BATCH_SIZE` and a request target longer than
 * `MAX_REQUEST_TARGET_LENGTH`. The client splits its batches using the same numbers, so a page that
 * issues many queries at once (for example the admin overview) is never refused by its own server.
 * Keeping one definition prevents the two sides from drifting apart.
 */
export const TRPC_MAX_BATCH_SIZE = 8;
export const MAX_REQUEST_TARGET_LENGTH = 8_192;
/** Client-side URL budget for a batched GET; leaves headroom for the path prefix and proxies. */
export const TRPC_CLIENT_MAX_URL_LENGTH = 6_000;
