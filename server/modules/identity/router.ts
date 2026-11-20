/**
 * Identity module — tRPC router (mounted at `trpc.identity.*`). Owner: identity module engineer.
 * Nest customer/staff/admin sub-routers as needed. Use only the guards from server/trpc/trpc.ts.
 */
import { router } from "../../trpc/trpc.js";

export const identityRouter = router({});
