import { z } from "zod";
import { ULID_PATTERN } from "../../core/ids.js";
import { adminProcedure, requireCapability, router, staffProcedure } from "../../trpc/trpc.js";
import { attentionHoursSchema } from "./attention.js";
import { operationalAlertListInput } from "./index.js";

const read = staffProcedure.use(requireCapability("ops.alerts.read"));
const manage = staffProcedure.use(requireCapability("ops.alerts.manage")).meta({ rateLimit: "form_submission" });
const id = z.strictObject({ publicId: z.string().regex(ULID_PATTERN) });
const configure = adminProcedure.use(requireCapability("platform.settings.manage"));

export const opsAlertsRouter = router({
  summary: read.query(({ ctx }) => ctx.services.opsAlerts.summary()),
  list: read.input(operationalAlertListInput).query(({ ctx, input }) => ctx.services.opsAlerts.list(input)),
  acknowledge: manage.input(id).mutation(({ ctx, input }) => ctx.services.opsAlerts.manage(ctx.session, input.publicId, "acknowledged")),
  resolve: manage.input(id).mutation(({ ctx, input }) => ctx.services.opsAlerts.manage(ctx.session, input.publicId, "resolved")),
  reminderConfig: adminProcedure.query(({ ctx }) => ctx.services.opsAlerts.reminderConfig()),
  updateReminderConfig: configure.meta({ rateLimit: "form_submission" }).input(z.strictObject({
    enabled: z.boolean(), hours: attentionHoursSchema,
  })).mutation(({ ctx, input }) => ctx.services.opsAlerts.updateReminderConfig(ctx.session, input)),
});
