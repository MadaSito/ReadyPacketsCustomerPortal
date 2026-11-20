/**
 * Audit module — tRPC router (mounted at `trpc.audit.*`). Owner: audit module engineer.
 * Nest customer/staff/admin sub-routers as needed. Use only the guards from server/trpc/trpc.ts.
 */
import { router } from "../../trpc/trpc.js";

export const auditRouter = router({});
