export const PHASE_NAMES: Record<string, string> = {
  received: "Upload received", quarantined: "Quarantined", verified: "Package verified", planned: "Plan ready for review",
  approved: "Apply approved", "objects-prepared": "Objects prepared", "records-committed": "Records committed",
  finalized: "Finalized", reconciled: "Reconciled; acceptance pending", accepted: "Accepted",
  "held-unknown": "Held for investigation", failed: "Stopped", canceled: "Canceled",
};

const REASONS: Record<string, string> = {
  PORTABLE_EMAIL_COLLISION: "An account already uses this email. The import will not link it.",
  PORTABLE_PUBLIC_ID_COLLISION: "This source customer ID already exists on the target.",
  PORTABLE_HISTORICAL_EVIDENCE: "Historical evidence retained without replay.",
  PORTABLE_HISTORICAL_FILE: "An inactive version retained as evidence.",
  PORTABLE_OPTIONAL_EXTENSION: "Unsupported optional content retained as evidence.",
  PORTABLE_HELD_FIELDS: "Additional source fields retained as evidence.",
  PORTABLE_TARGET_FILE_POLICY: "The file does not pass current target file policy.",
  PORTABLE_TARGET_POLICY: "This record is outside the target's supported data rules.",
  PORTABLE_ORDER_PROVENANCE_COLLISION: "This order already has a different import record.",
  PORTABLE_VERIFICATION_REFUSED: "Package verification did not pass. No business records were imported.",
  PORTABLE_RECONCILIATION_DISCREPANCY: "One or more checks did not match. Keep the original package and do not replay the import.",
  PORTABLE_APPLY_HELD: "The system could not confirm the outcome. Keep the package and inspect the audit trail before attempting another transfer.",
  PORTABLE_APPLY_REFUSED: "The import did not proceed. Review current authorization and target policy.",
};

export function describeReason(code: string | null | undefined) {
  return code ? REASONS[code] ?? "Review the audit trail for this transfer." : null;
}
