/**
 * Pure job and schedule identifiers for the Trash retention clean-up worker (Increment 09, Decision D2.4).
 * Kept free of runtime module imports so `jobs` and `trash` never form an import cycle.
 */
export const TRASH_JOB_RETENTION_CLEANUP = "trash.retention_cleanup" as const;
export const TRASH_SCHEDULE_RETENTION_EVERY_HOUR = "trash.retention.every_hour" as const;
