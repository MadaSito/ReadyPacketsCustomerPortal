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
import { storageRouter } from "../modules/storage/router.js";
import { sharepointRouter } from "../modules/sharepoint/router.js";
import { mailTemplatesRouter } from "../modules/mailTemplates/router.js";
import { automationsRouter } from "../modules/automations/router.js";
import { protectionRouter } from "../modules/protection/router.js";
import { publicApiRouter } from "../modules/publicApi/router.js";
import { communityRouter } from "../modules/community/router.js";
import { referralsRouter } from "../modules/referrals/router.js";
import { promotionsRouter } from "../modules/promotions/router.js";
import { reportsRouter } from "../modules/reports/router.js";
import { cartRouter } from "../modules/cart/router.js";
import { knowledgeRouter } from "../modules/knowledge/router.js";
import { paymentsRouter } from "../modules/payments/router.js";

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
  storage: storageRouter,
  sharepoint: sharepointRouter,
  mailTemplates: mailTemplatesRouter,
  automations: automationsRouter,
  protection: protectionRouter,
  publicApi: publicApiRouter,
  community: communityRouter,
  referrals: referralsRouter,
  promotions: promotionsRouter,
  reports: reportsRouter,
  cart: cartRouter,
  knowledge: knowledgeRouter,
  payments: paymentsRouter,
});

export type AppRouter = typeof appRouter;
