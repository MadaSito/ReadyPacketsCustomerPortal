/** tRPC context factory used by the HTTP pipeline. Owner: integrator (/root). */
import type { Request } from "express";
import type { Services } from "../container.js";
import { getHttpState } from "../http/requestState.js";
import type { TrpcContext } from "./trpc.js";

export function createTrpcContext(services: Services, req: Request): TrpcContext {
  const state = getHttpState(req);
  return { services, session: state.session, request: state.context, transport: state.transport };
}
