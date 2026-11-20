/**
 * Portable module — tRPC router (mounted at `trpc.portable.*`). Owner: portable module engineer.
 * Nest customer/staff/admin sub-routers as needed. Use only the guards from server/trpc/trpc.ts.
 */
import { router } from "../../trpc/trpc.js";

export const portableRouter = router({});
