import { adminProcedure, requireCapability, router, staffProcedure } from "../../trpc/trpc.js";
import { copyLogConnections, copyLogDetail, copyLogFilters, copyLogList } from "./copyLog.js";
import { orderCopyList, orderCopyRetry } from "./orderCopies.js";
import { storageAssignment, storageCreate, storageGet, storageList, storageTest, storageUpdate } from "./validation.js";

const admin = adminProcedure.use(requireCapability("storage.manage"));
const copyReader = adminProcedure.use(requireCapability("storage.copies.read"));

export const storageRouter = router({
  copies: router({
    forOrder: staffProcedure.use(requireCapability("orders.read_all")).input(orderCopyList)
      .query(({ ctx, input }) => ctx.services.storageConnections.orderCopies.forOrder(ctx.session, input)),
    retryOrderFile: staffProcedure.use(requireCapability("files.manage")).meta({ rateLimit: "expensive" }).input(orderCopyRetry)
      .mutation(({ ctx, input }) => ctx.services.storageConnections.orderCopies.retryOrderFile(ctx.session, input, ctx.request.requestId)),
    list: copyReader.input(copyLogList).query(({ ctx, input }) => ctx.services.storageConnections.copies.list(ctx.session, input)),
    detail: copyReader.input(copyLogDetail).query(({ ctx, input }) => ctx.services.storageConnections.copies.detail(ctx.session, input)),
    connections: copyReader.input(copyLogConnections).query(({ ctx, input }) => ctx.services.storageConnections.copies.connections(ctx.session, input)),
    exportCsv: copyReader.meta({ rateLimit: "expensive" }).input(copyLogFilters)
      .mutation(({ ctx, input }) => ctx.services.storageConnections.copies.exportCsv(ctx.session, input)),
    retry: copyReader.use(requireCapability("backup.run")).meta({ rateLimit: "expensive" }).input(copyLogDetail)
      .mutation(({ ctx, input }) => ctx.services.storageConnections.copies.retry(ctx.session, input)),
  }),
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
