import { z } from "zod";
import { ULID_PATTERN } from "../../core/ids.js";
import { adminProcedure, publicProcedure, requireCapability, router } from "../../trpc/trpc.js";
import { JOB_TYPE } from "./queue.js";
import { JOB_STATES, MAIL_STATES } from "./schema.js";

const publicId = z.string().regex(ULID_PATTERN);
const idInput = z.strictObject({ publicId });
const page = { limit: z.number().int().min(1).max(100).optional(), cursor: publicId.optional() };
const read = adminProcedure.use(requireCapability("jobs.read"));
const manage = adminProcedure.use(requireCapability("jobs.manage"));
const maintenanceManage = adminProcedure.use(requireCapability("maintenance.manage"));
const mailManage = adminProcedure.use(requireCapability("mail.manage"));

export const jobsRouter = router({
  maintenanceBanner: publicProcedure.query(({ ctx }) => ctx.services.jobAdmin.maintenanceBanner()),
  mail: router({
    content: adminProcedure.use(requireCapability("mail.content.read")).input(idInput)
      .mutation(({ ctx, input }) => ctx.services.jobAdmin.mailContent(ctx.session, input.publicId)),
    auditCopy: router({
      status: mailManage.query(({ ctx }) => ctx.services.jobAdmin.auditCopyStatus(ctx.session)),
      requestVerification: mailManage.mutation(({ ctx }) => ctx.services.jobAdmin.requestAuditCopyVerification(ctx.session)),
      confirmVerification: mailManage.input(z.strictObject({ code: z.string().regex(/^[a-zA-Z0-9_-]{22}$/) }))
        .mutation(({ ctx, input }) => ctx.services.jobAdmin.confirmAuditCopyVerification(ctx.session, input.code)),
    }),
  }),
  admin: router({
    list: read.input(z.strictObject({ ...page, type: z.string().max(100).regex(JOB_TYPE).optional(), state: z.enum(JOB_STATES).optional() }))
      .query(({ ctx, input }) => ctx.services.jobAdmin.list(ctx.session, input)),
    detail: read.input(idInput).query(({ ctx, input }) => ctx.services.jobAdmin.detail(ctx.session, input.publicId)),
    cancel: manage.input(idInput).mutation(({ ctx, input }) => ctx.services.jobAdmin.cancel(ctx.session, input.publicId)),
    retry: manage.input(idInput).mutation(({ ctx, input }) => ctx.services.jobAdmin.retry(ctx.session, input.publicId)),
    acknowledgeUnknown: maintenanceManage.input(z.strictObject({ publicId, confirmation: z.literal("RECONCILED") })).mutation(({ ctx, input }) =>
      ctx.services.jobAdmin.acknowledgeUnknown(ctx.session, input.publicId)),
    schedules: read.query(({ ctx }) => ctx.services.jobAdmin.schedules(ctx.session)),
    listMail: read.input(z.strictObject({ ...page, state: z.enum(MAIL_STATES).optional() }))
      .query(({ ctx, input }) => ctx.services.jobAdmin.listMail(ctx.session, input)),
    mailDetail: read.input(idInput).query(({ ctx, input }) => ctx.services.jobAdmin.mailDetail(ctx.session, input.publicId)),
    resend: manage.input(idInput).mutation(({ ctx, input }) => ctx.services.jobAdmin.resend(ctx.session, input.publicId)),
    capture: adminProcedure.use(requireCapability("jobs.mail.capture")).input(idInput)
      // A mutation (POST) keeps captured content out of GET and shared caches.
      .mutation(({ ctx, input }) => ctx.services.jobAdmin.capture(ctx.session, input.publicId)),
    maintenance: read.query(({ ctx }) => ctx.services.jobAdmin.maintenance(ctx.session)),
    setMaintenance: maintenanceManage.input(z.strictObject({ active: z.boolean(), expectedActive: z.boolean() }))
      .mutation(({ ctx, input }) => ctx.services.jobAdmin.setMaintenance(ctx.session, input)),
  }),
});
