import type { ModuleDeps } from "../../container.js";
import { enqueuePolicyNoticeMail, policyNoticeMailKey, registerPolicyNoticeJobs } from "../jobs/index.js";
import { createPolicyNotices, type PolicyNoticeBatch } from "./policyNotices.js";
import type { ClaimedJob, Tx } from "../../core/types.js";

export function createPolicyNoticeRuntime(deps: ModuleDeps) {
  // Registration is synchronous; the callback runs later after construction completes.
  const schedule = registerPolicyNoticeJobs(deps, (input: PolicyNoticeBatch, claim: ClaimedJobClaim, tx: Tx) =>
    service.runBatch(input, claim, tx));
  const service = createPolicyNotices(deps, {
    schedule,
    mail: (input, tx) => enqueuePolicyNoticeMail(deps.mailer, input, tx),
    mailKey: policyNoticeMailKey,
    mailStates: (keys, tx) => deps.services.jobAdmin.policyNoticeMailStates(keys, tx),
  });
  return service;
}

type ClaimedJobClaim = Pick<ClaimedJob, "signal" | "assertStillOwned">;
