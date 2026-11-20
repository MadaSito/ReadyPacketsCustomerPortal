/**
 * Platform module — tRPC router (mounted at `trpc.platform.*`). Owner: platform module engineer.
 * Nest customer/staff/admin sub-routers as needed. Use only the guards from server/trpc/trpc.ts.
 */
import { router } from "../../trpc/trpc.js";

export const platformRouter = router({});
