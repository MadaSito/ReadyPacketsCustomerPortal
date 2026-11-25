import { useMutation } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { roleHasCapability } from "@shared/capabilities";
import { useSession } from "@/lib/session";
import { errorMessage } from "@/lib/trpc";
import {
  Button,
  PageHeader,
  RouteTabPanel,
  RouteTabs,
  StepUpCancelledError,
  useStepUp,
  useToast,
  type RouteTabItem,
} from "@/ui";
import { AcceptanceLogTab, type AcceptanceLogUiFilters } from "./AcceptanceLogTab";
import { PolicyCoverageTab } from "./PolicyCoverageTab";
import { PolicyUpdatesTab } from "./PolicyUpdatesTab";
import {
  downloadCsvFile,
  parseUtcDateInputExclusiveEnd,
  parseUtcDateInputStart,
} from "./shared";
import { useAcceptanceLogProcedures, type AcceptanceLogFilterInput } from "./types";

const INITIAL_FILTERS: AcceptanceLogUiFilters = {
  customerDraft: "",
  customerQuery: "",
  customerPublicId: "",
  policyDocumentPublicId: "",
  versionPublicId: "",
  fromDate: "",
  toDate: "",
  source: "",
  method: "",
  freshness: "",
  orderReference: "",
};

const TAB_ITEMS: readonly RouteTabItem[] = [
  { value: "log", label: "Log", href: "/admin/policy-acceptances" },
  { value: "coverage", label: "Coverage", href: "/admin/policy-acceptances/coverage" },
  { value: "updates", label: "Policy updates", href: "/admin/policy-acceptances/updates" },
];

const TAB_ID_BASE = "policy-acceptances-tabs";

function activeTabFromPath(pathname: string): "log" | "coverage" | "updates" {
  if (pathname.endsWith("/coverage")) return "coverage";
  if (pathname.endsWith("/updates")) return "updates";
  return "log";
}

export default function PolicyAcceptancesPage() {
  const [location] = useLocation();
  const activeTab = activeTabFromPath(location);
  const { me } = useSession();
  const stepUp = useStepUp();
  const toast = useToast();
  const acceptanceLog = useAcceptanceLogProcedures();
  const exportMutation = useMutation(acceptanceLog.export.mutationOptions());

  const [filters, setFilters] = useState<AcceptanceLogUiFilters>(INITIAL_FILTERS);

  const role = me?.user.role;
  const canExport =
    (role === "staff" || role === "admin") &&
    roleHasCapability(role, "policies.acceptances.export");

  const filterInput = useMemo<AcceptanceLogFilterInput>(() => {
    const from = parseUtcDateInputStart(filters.fromDate);
    const to = parseUtcDateInputExclusiveEnd(filters.toDate);
    const trimmedOrder = filters.orderReference.trim();
    return {
      ...(filters.customerQuery ? { customerQuery: filters.customerQuery } : {}),
      ...(filters.customerPublicId ? { customerPublicId: filters.customerPublicId } : {}),
      ...(filters.policyDocumentPublicId
        ? { policyDocumentPublicId: filters.policyDocumentPublicId }
        : {}),
      ...(filters.versionPublicId ? { versionPublicId: filters.versionPublicId } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(filters.source ? { source: filters.source } : {}),
      ...(filters.method ? { method: filters.method } : {}),
      ...(filters.freshness ? { freshness: filters.freshness } : {}),
      ...(trimmedOrder ? { orderReference: trimmedOrder } : {}),
    };
  }, [filters]);

  const activeFilterCount = Object.keys(filterInput).length;

  const patchFilters = (patch: Partial<AcceptanceLogUiFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
  };

  const resetFilters = () => {
    setFilters(INITIAL_FILTERS);
  };

  const handleExportCsv = async () => {
    try {
      const result = await stepUp.run(
        () => exportMutation.mutateAsync(filterInput),
        { reason: "Confirm your identity to export the policy acceptance log as CSV." },
      );
      downloadCsvFile(result.csv, result.filename, result.contentType);
      toast.show({
        tone: result.truncated ? "warning" : "success",
        title: `Exported ${result.rowCount} acceptance ${result.rowCount === 1 ? "record" : "records"}`,
        description: result.truncated
          ? `Only the newest ${result.maxRows.toLocaleString()} matching records were exported. Narrow the filters to export older records.`
          : undefined,
      });
    } catch (err) {
      if (err instanceof StepUpCancelledError) return;
      toast.show({
        tone: "danger",
        title: "CSV export failed",
        description: errorMessage(err),
      });
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        className="min-w-0"
        title="Policy acceptances"
        description="Read-only evidence of customer account, checkout, and order-gate policy acceptances, coverage, and published updates."
        actions={
          activeTab === "log" && canExport ? (
            <Button
              variant="secondary"
              leadingIcon={<Download className="size-4" aria-hidden="true" />}
              loading={exportMutation.isPending}
              onClick={() => void handleExportCsv()}
            >
              Export CSV
            </Button>
          ) : undefined
        }
      />

      <RouteTabs
        idBase={TAB_ID_BASE}
        label="Policy acceptance views"
        items={TAB_ITEMS}
        value={activeTab}
      />

      <RouteTabPanel idBase={TAB_ID_BASE} value={activeTab} className="min-w-0">
        {activeTab === "coverage" ? (
          <PolicyCoverageTab />
        ) : activeTab === "updates" ? (
          <PolicyUpdatesTab />
        ) : (
          <AcceptanceLogTab
            filters={filters}
            filterInput={filterInput}
            activeFilterCount={activeFilterCount}
            onPatchFilters={patchFilters}
            onResetFilters={resetFilters}
          />
        )}
      </RouteTabPanel>
    </div>
  );
}
