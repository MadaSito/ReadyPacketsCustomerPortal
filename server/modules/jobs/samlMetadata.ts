import type { ClaimedJob, JobQueue, JobResult } from "../../core/types.js";

export const SAML_METADATA_CHECK_JOB = "identity.saml.metadata_check";

/** Identity owns the idempotent, fenced handler and all outbound/provider behavior. */
export function registerSamlMetadataCheck(jobs: JobQueue, handler: (job: ClaimedJob) => Promise<JobResult>): void {
  jobs.register(SAML_METADATA_CHECK_JOB, handler, { retrySafe: true });
  jobs.registerSchedule({ name: SAML_METADATA_CHECK_JOB, type: SAML_METADATA_CHECK_JOB, everyMs: 24 * 60 * 60 * 1_000 });
}
