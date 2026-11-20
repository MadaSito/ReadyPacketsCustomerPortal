/**
 * Identity module — tRPC router (mounted at `trpc.identity.*`). Owner: identity module engineer.
 * Routers validate + guard + call the service. Business rules and scope live in the service.
 */
import { z } from "zod";
import { USER_ROLES, PASSWORD_POLICY } from "../../../shared/domain.js";
import { DomainError } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import {
  adminProcedure,
  protectedProcedure,
  publicProcedure,
  requireCapability,
  router,
  sessionProcedure,
  staffProcedure,
} from "../../trpc/trpc.js";
import { customerRefSchema, emailSchema, nameSchema } from "./normalize.js";
import { USER_STATUSES } from "./schema.js";

/** Raw bound only (policy is enforced by the service with code-point counting; never truncated). */
const password = z.string().min(1).max(1024);
const token = z.string().min(1).max(128);
const publicId = z.string().regex(ULID_PATTERN, "Invalid identifier.");
const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/);
const listInput = z
  .strictObject({
    query: z.string().max(120).optional(),
    status: z.enum(USER_STATUSES).optional(),
    cursor: z.string().max(64).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .optional();
const statusInput = z.strictObject({ customerId: publicId, status: z.enum(["active", "suspended", "deactivated"]), reasonCode });

export const identityRouter = router({
  passwordPolicy: publicProcedure.query(() => ({ minLength: PASSWORD_POLICY.minLength, maxLength: PASSWORD_POLICY.maxLength })),

  register: publicProcedure
    .meta({ rateLimit: "auth_high_risk" })
    .input(z.strictObject({ email: emailSchema, name: nameSchema, password }))
    .mutation(({ ctx, input }) =>
      ctx.services.identity.auth.register(input, { ipAddress: ctx.request.ipAddress, userAgent: ctx.request.userAgent }),
    ),

  signIn: publicProcedure
    .meta({ rateLimit: "user_login" })
    .input(z.strictObject({ email: z.string().max(320), password }))
    .mutation(async ({ ctx, input }) => {
      // An existing session on this browser is ended before a new identity is established (no fixation).
      if (ctx.session) await ctx.services.identity.auth.signOut(ctx.session);
      const result = await ctx.services.identity.auth.signIn(input, { ipAddress: ctx.request.ipAddress, userAgent: ctx.request.userAgent });
      ctx.transport.issue(result.issued);
      return { nextStep: result.nextStep };
    }),

  verifyEmail: publicProcedure
    .meta({ rateLimit: "auth_high_risk" })
    .input(z.strictObject({ token }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.services.identity.auth.verifyEmail(input.token, ctx.session);
      if (result.issued) ctx.transport.issue(result.issued);
      return { verified: true as const };
    }),

  requestPasswordReset: publicProcedure
    .meta({ rateLimit: "auth_high_risk" })
    .input(z.strictObject({ email: emailSchema }))
    .mutation(({ ctx, input }) => ctx.services.identity.auth.requestPasswordReset(input)),

  resetPassword: publicProcedure
    .meta({ rateLimit: "auth_high_risk" })
    .input(z.strictObject({ token, password }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.services.identity.auth.resetPassword(input);
      if (ctx.session) ctx.transport.clear(); // all sessions were revoked
      return result;
    }),

  activateAccount: publicProcedure
    .meta({ rateLimit: "auth_high_risk" })
    .input(z.strictObject({ token, password }))
    .mutation(({ ctx, input }) => ctx.services.identity.auth.activateAccount(input)),

  signOut: publicProcedure.mutation(async ({ ctx }) => {
    await ctx.services.identity.auth.signOut(ctx.session);
    ctx.transport.clear();
    return { ok: true as const };
  }),

  /** The single next-action endpoint: the client renders `nextStep` and nothing else decides routing. */
  me: sessionProcedure.query(async ({ ctx }) => {
    const user = await ctx.services.identity.getUser(ctx.session.userId);
    if (!user) throw new DomainError("UNAUTHENTICATED", "NO_SESSION", "Please sign in to continue.");
    const timing = await ctx.services.identity.sessions.timing(ctx.session.sessionId);
    if (!timing) throw new DomainError("UNAUTHENTICATED", "NO_SESSION", "Please sign in to continue.");
    return {
      user: { publicId: user.publicId, role: user.role, name: user.name, email: user.email, customerRef: user.customerRef, status: user.status },
      state: ctx.session.state,
      pendingSteps: [...ctx.session.pendingSteps],
      nextStep: ctx.session.pendingSteps[0] ?? null,
      session: { idleTimeoutSeconds: timing.idleTimeoutSeconds, absoluteExpiresAt: timing.absoluteExpiresAt.toISOString() },
    };
  }),

  resendVerification: sessionProcedure
    .meta({ rateLimit: "auth_high_risk" })
    .mutation(({ ctx }) => ctx.services.identity.auth.resendVerification(ctx.session)),

  changePassword: sessionProcedure
    .meta({ rateLimit: "auth_high_risk" })
    .input(z.strictObject({ currentPassword: password, newPassword: password }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.services.identity.auth.changePassword(ctx.session, input);
      ctx.transport.issue(result.issued);
      return { nextStep: result.nextStep };
    }),

  profile: router({
    update: protectedProcedure.input(z.strictObject({ name: nameSchema })).mutation(async ({ ctx, input }) => {
      await ctx.services.identity.admin.updateOwnProfile(ctx.session, input);
      return { ok: true as const };
    }),
  }),

  sessions: router({
    list: protectedProcedure.query(async ({ ctx }) => ({ items: await ctx.services.identity.listSessions(ctx.session) })),
    revoke: protectedProcedure.input(z.strictObject({ sessionId: publicId })).mutation(async ({ ctx, input }) => {
      await ctx.services.identity.admin.revokeOwnSession(ctx.session, input.sessionId);
      if (input.sessionId === ctx.session.sessionId) ctx.transport.clear();
      return { ok: true as const };
    }),
    revokeOthers: protectedProcedure.mutation(async ({ ctx }) => ({
      revoked: await ctx.services.identity.admin.revokeOtherSessions(ctx.session),
    })),
  }),

  admin: router({
    customers: router({
      list: staffProcedure
        .use(requireCapability("customers.read_all"))
        .input(listInput)
        .query(({ ctx, input }) => ctx.services.identity.searchCustomers(ctx.session, input ?? {})),
      get: staffProcedure
        .use(requireCapability("customers.read_all"))
        .input(z.strictObject({ customerId: publicId }))
        .query(({ ctx, input }) => ctx.services.identity.admin.getCustomer(ctx.session, input.customerId)),
      create: adminProcedure
        .use(requireCapability("customers.manage"))
        .input(z.strictObject({ email: emailSchema, name: nameSchema, customerRef: customerRefSchema.optional() }))
        .mutation(({ ctx, input }) => ctx.services.identity.admin.createCustomer(ctx.session, input)),
      resendInvitation: adminProcedure
        .use(requireCapability("customers.manage"))
        .input(z.strictObject({ customerId: publicId }))
        .mutation(({ ctx, input }) => ctx.services.identity.admin.resendInvitation(ctx.session, input.customerId)),
      setStatus: adminProcedure
        .use(requireCapability("customers.manage"))
        .input(statusInput)
        .mutation(({ ctx, input }) => ctx.services.identity.admin.setCustomerStatus(ctx.session, input.customerId, input.status, input.reasonCode)),
      changeReference: adminProcedure
        .use(requireCapability("customers.reference.change"))
        .input(z.strictObject({ customerId: publicId, newReference: customerRefSchema, expectedVersion: z.number().int().min(1), reasonCode }))
        .mutation(({ ctx, input }) =>
          ctx.services.identity.admin.changeReference(ctx.session, input.customerId, input.newReference, input.expectedVersion, input.reasonCode),
        ),
    }),
    users: router({
      revokeSessions: adminProcedure
        .use(requireCapability("sessions.revoke_any"))
        .input(z.strictObject({ userId: publicId }))
        .mutation(({ ctx, input }) => ctx.services.identity.admin.revokeUserSessions(ctx.session, input.userId)),
    }),
    staff: router({
      list: adminProcedure
        .use(requireCapability("staff.manage"))
        .input(listInput)
        .query(({ ctx, input }) => ctx.services.identity.admin.listStaff(ctx.session, input ?? {})),
      create: adminProcedure
        .use(requireCapability("staff.manage"))
        .input(z.strictObject({ email: emailSchema, name: nameSchema, role: z.enum(["staff", "admin"]) }))
        .mutation(({ ctx, input }) => ctx.services.identity.admin.createStaff(ctx.session, input)),
      resendInvitation: adminProcedure
        .use(requireCapability("staff.manage"))
        .input(z.strictObject({ userId: publicId }))
        .mutation(({ ctx, input }) => ctx.services.identity.admin.resendInvitation(ctx.session, input.userId, ["staff", "admin"])),
      changeRole: adminProcedure
        .use(requireCapability("staff.manage"))
        .input(z.strictObject({ userId: publicId, role: z.enum(USER_ROLES), expectedVersion: z.number().int().min(1) }))
        .mutation(({ ctx, input }) => ctx.services.identity.admin.changeRole(ctx.session, input.userId, input.role, input.expectedVersion)),
      setStatus: adminProcedure
        .use(requireCapability("staff.manage"))
        .input(z.strictObject({ userId: publicId, status: z.enum(["active", "suspended", "deactivated"]), reasonCode }))
        .mutation(({ ctx, input }) => ctx.services.identity.admin.setStaffStatus(ctx.session, input.userId, input.status, input.reasonCode)),
    }),
  }),
});
