import { adminProcedure, requireCapability, router } from "../../trpc/trpc.js";
import { storageAssignment, storageCreate, storageGet, storageList, storageTest, storageUpdate } from "./validation.js";

const admin = adminProcedure.use(requireCapability("storage.manage"));

export const storageRouter = router({
  connections: router({
    list: admin.input(storageList).query(({ ctx, input }) => ctx.services.storageConnections.connections.list(ctx.session, input)),
    get: admin.input(storageGet).query(({ ctx, input }) => ctx.services.storageConnections.connections.get(ctx.session, input)),
    create: admin.input(storageCreate).mutation(({ ctx, input }) => ctx.services.storageConnections.connections.create(ctx.session, input)),
    update: admin.input(storageUpdate).mutation(({ ctx, input }) => ctx.services.storageConnections.connections.update(ctx.session, input)),
    test: admin.input(storageTest).mutation(({ ctx, input }) => ctx.services.storageConnections.connections.test(ctx.session, input)),
  }),
  assignments: router({
    list: admin.query(({ ctx }) => ctx.services.storageConnections.assignments.list(ctx.session)),
    set: admin.input(storageAssignment).mutation(({ ctx, input }) => ctx.services.storageConnections.assignments.set(ctx.session, input)),
  }),
});
