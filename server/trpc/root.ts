/** Root tRPC router. Owner: integrator (/root). Each module mounts exactly one router. */
import { router } from "./trpc.js";
import { identityRouter } from "../modules/identity/router.js";
import { assuranceRouter } from "../modules/assurance/router.js";
import { ordersRouter } from "../modules/orders/router.js";
import { filesRouter } from "../modules/files/router.js";
import { engagementRouter } from "../modules/engagement/router.js";
import { complianceRouter } from "../modules/compliance/router.js";
import { auditRouter } from "../modules/audit/router.js";
import { siemRouter } from "../modules/siem/router.js";
import { platformRouter } from "../modules/platform/router.js";
import { jobsRouter } from "../modules/jobs/router.js";
import { portableRouter } from "../modules/portable/router.js";
import { backupRouter } from "../modules/backup/router.js";
import { integrationsRouter } from "../modules/integrations/router.js";

export const appRouter = router({
  identity: identityRouter,
  assurance: assuranceRouter,
  orders: ordersRouter,
  files: filesRouter,
  engagement: engagementRouter,
  compliance: complianceRouter,
  audit: auditRouter,
  siem: siemRouter,
  platform: platformRouter,
  jobs: jobsRouter,
  portable: portableRouter,
  backup: backupRouter,
  integrations: integrationsRouter,
});

export type AppRouter = typeof appRouter;
