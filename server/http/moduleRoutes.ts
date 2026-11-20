/** Mounts every module raw-HTTP router under /api/<module>. Owner: integrator (/root). */
import { Router } from "express";
import type { Services } from "../container.js";
import { registerIdentityHttpRoutes } from "../modules/identity/http.js";
import { registerAssuranceHttpRoutes } from "../modules/assurance/http.js";
import { registerOrdersHttpRoutes } from "../modules/orders/http.js";
import { registerFilesHttpRoutes } from "../modules/files/http.js";
import { registerEngagementHttpRoutes } from "../modules/engagement/http.js";
import { registerComplianceHttpRoutes } from "../modules/compliance/http.js";
import { registerAuditHttpRoutes } from "../modules/audit/http.js";
import { registerSiemHttpRoutes } from "../modules/siem/http.js";
import { registerPlatformHttpRoutes } from "../modules/platform/http.js";
import { registerJobsHttpRoutes } from "../modules/jobs/http.js";
import { registerPortableHttpRoutes } from "../modules/portable/http.js";
import { registerBackupHttpRoutes } from "../modules/backup/http.js";
import { registerIntegrationsHttpRoutes } from "../modules/integrations/http.js";

/** Returns one router to mount at `/api` AFTER request context, session resolution, CSRF/origin and rate limits. */
export function createModuleHttpRouter(services: Services): Router {
  const api = Router();
  { const r = Router(); registerIdentityHttpRoutes(r, services); api.use("/identity", r); }
  { const r = Router(); registerAssuranceHttpRoutes(r, services); api.use("/assurance", r); }
  { const r = Router(); registerOrdersHttpRoutes(r, services); api.use("/orders", r); }
  { const r = Router(); registerFilesHttpRoutes(r, services); api.use("/files", r); }
  { const r = Router(); registerEngagementHttpRoutes(r, services); api.use("/engagement", r); }
  { const r = Router(); registerComplianceHttpRoutes(r, services); api.use("/compliance", r); }
  { const r = Router(); registerAuditHttpRoutes(r, services); api.use("/audit", r); }
  { const r = Router(); registerSiemHttpRoutes(r, services); api.use("/siem", r); }
  { const r = Router(); registerPlatformHttpRoutes(r, services); api.use("/platform", r); }
  { const r = Router(); registerJobsHttpRoutes(r, services); api.use("/jobs", r); }
  { const r = Router(); registerPortableHttpRoutes(r, services); api.use("/portable", r); }
  { const r = Router(); registerBackupHttpRoutes(r, services); api.use("/backup", r); }
  { const r = Router(); registerIntegrationsHttpRoutes(r, services); api.use("/integrations", r); }
  return api;
}
