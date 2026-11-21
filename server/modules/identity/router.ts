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
import { SSO_JIT_MODES, USER_STATUSES } from "./schema.js";
import type { SignInMethods } from "./sso/service.js";
import type { Services } from "../../container.js";

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
const guid = z.string().trim().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "Enter a GUID.");
const ssoConfigInput = z.strictObject({
  expectedVersion: z.number().int().min(1),
  tenantId: guid.nullable(),
  clientId: guid.nullable(),
  /** Write-only: omit = keep, null = clear, string = replace. */
  clientSecret: z.string().min(1).max(512).nullable().optional(),
  buttonLabel: z.string().trim().max(60).nullable(),
  allowedDomains: z.array(z.string().trim().min(1).max(253)).max(50),
  trustEntraMfa: z.boolean(),
  jitMode: z.enum(SSO_JIT_MODES),
  jitStaffAppRole: z.string().trim().max(120).nullable(),
  jitDailyLimit: z.number().int().min(1).max(500),
});

/** Adds the sign-in method column (password / Microsoft) to list pages. */
async function withSignInMethods<T extends { publicId: string }>(services: Services, page: { items: T[]; nextCursor: string | null }) {
  const methods = await services.identity.sso.signInMethods(page.items.map((item) => item.publicId));
  const none: SignInMethods = { password: false, sso: null };
  return { ...page, items: page.items.map((item) => ({ ...item, signInMethods: methods.get(item.publicId) ?? none })) };
}

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
  me: sessionProcedure.meta({ sessionProbe: true }).query(async ({ ctx }) => {
    const user = await ctx.services.identity.getUser(ctx.session.userId);
    if (!user) throw new DomainError("UNAUTHENTICATED", "NO_SESSION", "Please sign in to continue.");
    const timing = await ctx.services.identity.sessions.timing(ctx.session.sessionId);
    if (!timing) throw new DomainError("UNAUTHENTICATED", "NO_SESSION", "Please sign in to continue.");
    return {
      user: { publicId: user.publicId, role: user.role, name: user.name, email: user.email, customerRef: user.customerRef, status: user.status },
      state: ctx.session.state,
      pendingSteps: [...ctx.session.pendingSteps],
      nextStep: ctx.session.pendingSteps[0] ?? null,
      session: {
        idleTimeoutSeconds: timing.idleTimeoutSeconds,
        absoluteExpiresAt: timing.absoluteExpiresAt.toISOString(),
        authMethod: ctx.session.authMethod,
      },
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

  /** Microsoft Entra ID single sign-on (raw start/callback/complete routes live in http.ts). */
  sso: router({
    publicConfig: publicProcedure.query(({ ctx }) => ctx.services.identity.sso.publicConfig()),
    prepare: protectedProcedure
      .meta({ rateLimit: "auth_high_risk" })
      .input(z.strictObject({ purpose: z.enum(["link", "step_up", "test"]), next: z.string().max(512).optional() }))
      .mutation(({ ctx, input }) => ctx.services.identity.sso.prepare(ctx.session, input.purpose, input.next)),
    myLink: protectedProcedure.query(({ ctx }) => ctx.services.identity.sso.myLink(ctx.session)),
    unlinkSelf: protectedProcedure.meta({ rateLimit: "auth_high_risk" }).mutation(async ({ ctx }) => {
      await ctx.services.identity.sso.unlinkSelf(ctx.session);
      return { ok: true as const };
    }),
  }),

  admin: router({
    sso: router({
      get: adminProcedure.use(requireCapability("identity.sso.manage")).query(({ ctx }) => ctx.services.identity.sso.adminView()),
      update: adminProcedure
        .use(requireCapability("identity.sso.manage"))
        .input(ssoConfigInput)
        .mutation(({ ctx, input }) => ctx.services.identity.sso.updateConfig(ctx.session, input)),
      setEnabled: adminProcedure
        .use(requireCapability("identity.sso.manage"))
        .input(z.strictObject({ enabled: z.boolean(), expectedVersion: z.number().int().min(1) }))
        .mutation(({ ctx, input }) => ctx.services.identity.sso.setEnabled(ctx.session, input.enabled, input.expectedVersion)),
      bindUser: adminProcedure
        .use(requireCapability("identity.sso.manage"))
        .input(z.strictObject({ userId: publicId, objectId: guid }))
        .mutation(({ ctx, input }) => ctx.services.identity.sso.bindUser(ctx.session, input.userId, input.objectId)),
      unbindUser: adminProcedure
        .use(requireCapability("identity.sso.manage"))
        .input(z.strictObject({ userId: publicId }))
        .mutation(async ({ ctx, input }) => {
          await ctx.services.identity.sso.unbindUser(ctx.session, input.userId);
          return { ok: true as const };
        }),
    }),
    customers: router({
      list: staffProcedure
        .use(requireCapability("customers.read_all"))
        .input(listInput)
        .query(async ({ ctx, input }) => withSignInMethods(ctx.services, await ctx.services.identity.searchCustomers(ctx.session, input ?? {}))),
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
        .query(async ({ ctx, input }) => withSignInMethods(ctx.services, await ctx.services.identity.admin.listStaff(ctx.session, input ?? {}))),
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
