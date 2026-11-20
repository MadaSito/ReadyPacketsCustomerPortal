import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as transportModule from "@/lib/sessionTransport";
import type * as trpcModule from "@/lib/trpc";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import BackupDetailPage from "./BackupDetailPage";
import BackupsPage, { Posture } from "./BackupsPage";
import {
  STALE_AFTER_MS, confirmationPhrase, freshness, recommendedArchive, restoreCommand,
  type Archive, type BackupDetail, type BackupList, type RestoreDrill, type Verification,
} from "./model";
import RestorePage from "./RestorePage";
import RetentionPage, { policyErrors } from "./RetentionPage";
import { backupFeature } from "./routes";

/* ---- tRPC mock: every procedure path resolves through `handlers[path]` ---- */
const { handlers, fetchMock, session } = vi.hoisted(() => ({
  handlers: {} as Record<string, (input: unknown) => unknown>, fetchMock: vi.fn(), session: { role: "admin" as string },
}));
vi.mock("@/lib/sessionTransport", async (original) => ({ ...await original<typeof transportModule>(), sessionFetch: fetchMock }));
vi.mock("@/lib/session", () => ({ useSession: () => ({ me: { state: "full", user: { role: session.role } }, view: { status: "full", role: session.role } }) }));
vi.mock("@/lib/trpc", async (original) => {
  const call = (path: string, input: unknown) => {
    const handler = handlers[path];
    if (!handler) return Promise.reject(new Error(`unmocked ${path}`));
    try { return Promise.resolve(handler(input)); } catch (e) { return Promise.reject(e); }
  };
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        const key = path.join(".");
        if (prop === "queryOptions") return (input?: unknown) => ({ queryKey: [key, input ?? null], queryFn: () => call(key, input) });
        if (prop === "infiniteQueryOptions") {
          return (input: Record<string, unknown>, opts: { getNextPageParam: (p: unknown) => unknown }) => ({
            queryKey: [key, input, "infinite"],
            queryFn: ({ pageParam }: { pageParam: unknown }) => call(key, { ...input, cursor: pageParam }),
            initialPageParam: null,
            getNextPageParam: opts.getNextPageParam,
          });
        }
        if (prop === "mutationOptions") return () => ({ mutationFn: (input: unknown) => call(key, input) });
        if (prop === "pathFilter" || prop === "queryFilter") return () => ({ queryKey: [key] });
        if (prop === "queryKey" || prop === "pathKey") return () => [key];
        return node([...path, prop]);
      },
    });
  return { ...await original<typeof trpcModule>(), useTRPC: () => node([]), useTRPCClient: () => node([]) };
});

const NOW = new Date("2026-11-20T12:00:00.000Z");
const ID = "bk_synthetic_0001";
const archive = (patch: Partial<Archive> = {}): Archive => ({
  publicId: ID, state: "completed", reasonCode: null, trigger: "scheduled", encryptedSizeBytes: 4096, archiveSha256: "a".repeat(64),
  backupKeyId: "bk-key-2026", keyCustodyMode: "host_file", releaseRef: "test", schemaMigrationCount: 12, lastMigrationHash: "b".repeat(64),
  objectCount: 3, objectTotalBytes: 2048, verificationStatus: "verified", lastVerifiedAt: new Date(NOW.getTime() - 3_600_000),
  offHostCopyStatus: "local_only", activeHoldCount: 0, isLastKnownGood: true, createdAt: new Date(NOW.getTime() - 3_600_000),
  completedAt: new Date(NOW.getTime() - 3_500_000), purgedAt: null, ...patch,
});
const verification = (patch: Partial<Verification> = {}): Verification => ({
  publicId: "bv_synthetic_0001", backupPublicId: ID, state: "completed", reasonCode: null, authenticatedBytes: 4096, chunksVerified: 2,
  sqlSha256Matched: true, objectsVerified: 3, manifestValid: true, keyReadiness: "ready", missingDataKeyIds: [], durationMs: 900,
  createdAt: new Date(NOW.getTime() - 3_000_000), completedAt: new Date(NOW.getTime() - 2_999_000), ...patch,
});
const drill = (patch: Partial<RestoreDrill> = {}): RestoreDrill => ({
  publicId: "rd_synthetic_0001", backupPublicId: ID, state: "completed", reasonCode: null, targetDatabaseName: "rp_drill_one",
  continuityMode: "preserve_continuity", achievedDataAgeMs: 3_600_000, durationMs: 42_000,
  continuity: {
    continuityMode: "preserve_continuity", sessionsRevoked: 4, singleUseTokensRetired: 2, ephemeralChallengesCleared: 1, downloadTicketsCleared: 0,
    totpWatermarksAdvanced: 3, passkeyCountersReconciled: 0, recoveryCodesReconciled: 1, queuedJobsQuarantined: 5, queuedMailQuarantined: 2,
    externalFlagsDisabled: 1, auditChainVerified: "verified", auditContinuityMarkerAppended: true,
  },
  integrity: { schemaMigrationsMatched: true, restoredMigrationCount: 12, expectedMigrationCount: 12, tablesChecked: 40, tableRowMismatches: [], objectsChecked: 3, objectHashMismatches: 0, passed: true },
  createdAt: NOW, completedAt: NOW, ...patch,
});
const listPage = (items: Archive[], patch: Partial<BackupList> = {}): BackupList => ({
  items, nextCursor: null, keyConfigured: true, keyCustodyWarning: null,
  offHostStatusNote: "Local storage only: off-host independent copy is not configured.", ...patch,
});
const detail = (patch: Partial<BackupDetail> = {}): BackupDetail => ({ archive: archive(), verifications: [verification()], restores: [drill()], holds: [], ...patch });
const policy = { keepLastCount: 14, maxAgeDays: 90, scheduleEnabled: true, autoPruneEnabled: false, recoverySandboxRoot: "/var/lib/synthetic" };

beforeEach(() => {
  session.role = "admin";
  for (const k of Object.keys(handlers)) delete handlers[k];
  handlers["jobs.maintenanceBanner"] = () => ({ active: false, message: null });
  handlers["backup.admin.list"] = () => listPage([archive()]);
  handlers["backup.admin.retentionPolicy"] = () => policy;
  handlers["backup.admin.detail"] = () => detail();
});
afterEach(() => { fetchMock.mockReset(); vi.restoreAllMocks(); });

describe("backup model", () => {
  it("measures freshness against the 26-hour target and ignores failed backups", () => {
    expect(freshness([], NOW.getTime()).kind).toBe("none");
    expect(freshness([archive({ state: "failed" })], NOW.getTime()).kind).toBe("none");
    expect(freshness([archive()], NOW.getTime()).kind).toBe("fresh");
    const old = archive({ completedAt: new Date(NOW.getTime() - STALE_AFTER_MS - 1000) });
    expect(freshness([old], NOW.getTime()).kind).toBe("stale");
  });

  it("builds the operator restore command with the exact confirmation phrase and no secrets", () => {
    expect(confirmationPhrase(ID, "rp_drill")).toBe(`RESTORE ${ID} TO rp_drill`);
    const cmd = restoreCommand(ID);
    expect(cmd).toContain("scripts/ops/restore/restore-isolated.ts");
    expect(cmd).toContain(`--confirm "RESTORE ${ID} TO rp_restore_<YYYYMMDD>"`);
    // Secrets only by *_FILE path, never inline values on argv.
    for (const line of cmd.split("\n").filter((l) => l.includes("="))) expect(line).toMatch(/^RP_[A-Z_]+_FILE=\/etc\/readypackets\/secrets\//u);
    expect(restoreCommand(null)).toContain("RESTORE <BACKUP_PUBLIC_ID> TO");
  });

  it("recommends the last known good backup, else the newest verified one", () => {
    const a = archive({ publicId: "bk_synthetic_000a", isLastKnownGood: false });
    const b = archive({ publicId: "bk_synthetic_000b", isLastKnownGood: true });
    expect(recommendedArchive([a, b])?.publicId).toBe("bk_synthetic_000b");
    expect(recommendedArchive([a])?.publicId).toBe("bk_synthetic_000a");
    expect(recommendedArchive([archive({ isLastKnownGood: false, verificationStatus: "unverified" })])).toBeNull();
  });

  it("validates retention bounds like the server", () => {
    expect(policyErrors("14", "90")).toEqual({});
    expect(policyErrors("0", "90").keep).toBeDefined();
    expect(policyErrors("366", "90").keep).toBeDefined();
    expect(policyErrors("14", "3651").age).toBeDefined();
    expect(policyErrors("1.5", "x")).toMatchObject({ keep: expect.any(String), age: expect.any(String) });
  });

  it("registers admin-only routes with restore before the detail pattern and a Platform nav entry", () => {
    const paths = backupFeature.routes.map((r) => r.path);
    expect(paths.indexOf("/admin/backups/restore")).toBeLessThan(paths.indexOf("/admin/backups/:backupId"));
    expect(paths.indexOf("/admin/backups/retention")).toBeLessThan(paths.indexOf("/admin/backups/:backupId"));
    expect(backupFeature.routes.every((r) => r.access === "admin")).toBe(true);
    expect(backupFeature.nav?.[0]).toMatchObject({ group: "Platform", href: "/admin/backups", capability: "backup.read" });
  });
});

describe("Backups page", () => {
  it("shows inventory, schedule, truthful off-host status and key custody without exposing the key", async () => {
    const { container } = renderUi(<BackupsPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "Backups" })).toBeInTheDocument();
    expect((await screen.findAllByText("bk-key-2026")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Not configured").length).toBeGreaterThan(0);
    expect(screen.getByText(/off-host independent copy is not configured/u)).toBeInTheDocument();
    expect(screen.getByText(/never shown in this console/u)).toBeInTheDocument();
    expect(await screen.findByText("On")).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("marks archives removed by retention", async () => {
    handlers["backup.admin.list"] = () => listPage([archive({ purgedAt: NOW, isLastKnownGood: false })]);
    renderUi(<BackupsPage />);
    expect((await screen.findAllByText("Removed by retention")).length).toBeGreaterThan(0);
  });

  it("links to retention and the restore procedure without a restore button", async () => {
    renderUi(<BackupsPage />);
    expect(await screen.findByRole("link", { name: "How to restore" })).toHaveAttribute("href", "/admin/backups/restore");
    expect(screen.getByRole("link", { name: "Retention" })).toHaveAttribute("href", "/admin/backups/retention");
  });

  it("warns when the newest successful backup is stale", () => {
    const old = archive({ completedAt: new Date(NOW.getTime() - 30 * 3_600_000) });
    renderUi(<Posture items={[old]} keyConfigured offHostStatusNote="Local only." policy={policy} now={NOW.getTime()} />);
    expect(screen.getByText("Latest backup is out of date")).toBeInTheDocument();
  });

  it("warns when there is no successful backup at all", () => {
    renderUi(<Posture items={[archive({ state: "failed" })]} keyConfigured offHostStatusNote="Local only." policy={policy} now={NOW.getTime()} />);
    expect(screen.getByText("No successful backup")).toBeInTheDocument();
  });

  it("runs a backup after confirmation", async () => {
    const runNow = vi.fn(() => ({ backupPublicId: "bk_synthetic_0002", jobId: "job_1" }));
    handlers["backup.admin.runNow"] = runNow;
    renderUi(<BackupsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Run backup now" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Run backup" }));
    await waitFor(() => expect(runNow).toHaveBeenCalledWith({ trigger: "manual" }));
    expect(await screen.findByText("Backup queued")).toBeInTheDocument();
  });

  it("disables run-now when no key is configured or maintenance is draining", async () => {
    handlers["backup.admin.list"] = () => listPage([], { keyConfigured: false });
    renderUi(<BackupsPage />);
    expect(await screen.findByText("No backup key configured")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run backup now" })).toBeDisabled();
  });

  it("surfaces maintenance draining", async () => {
    handlers["jobs.maintenanceBanner"] = () => ({ active: true, message: "Upgrade window" });
    renderUi(<BackupsPage />);
    expect(await screen.findByText("Maintenance in progress")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Run backup now" })).toBeDisabled());
  });

  it("hides privileged actions from roles without the capability", async () => {
    session.role = "staff";
    renderUi(<BackupsPage />);
    await screen.findByRole("heading", { level: 1, name: "Backups" });
    expect(screen.queryByRole("button", { name: "Run backup now" })).toBeNull();
  });
});

describe("Backup detail page", () => {
  const path = `/admin/backups/${ID}`;
  const renderDetail = () => renderUi(<BackupDetailRoute />, { path });

  it("shows verifications, drill records and the drill report", async () => {
    const { container } = renderDetail();
    expect(await screen.findByRole("heading", { level: 1, name: "Backup" })).toBeInTheDocument();
    expect((await screen.findAllByText("rp_drill_one")).length).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
    await userEvent.click(screen.getAllByRole("button", { name: /Report for restore drill/u })[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Integrity checks passed")).toBeInTheDocument();
    expect(within(dialog).getByText("Sessions revoked")).toBeInTheDocument();
  });

  it("verifies on request", async () => {
    const verify = vi.fn(() => verification());
    handlers["backup.admin.verify"] = verify;
    renderDetail();
    await userEvent.click(await screen.findByRole("button", { name: "Verify now" }));
    await waitFor(() => expect(verify).toHaveBeenCalledWith({ backupPublicId: ID }));
    expect(await screen.findByText("Backup verified")).toBeInTheDocument();
  });

  it("downloads the encrypted archive and rejects a size mismatch", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:synthetic"), revokeObjectURL: vi.fn() });
    const ok = () => new Response(new Uint8Array(4096), { status: 200, headers: { "content-disposition": "attachment; filename=x.rpbk" } });
    fetchMock.mockResolvedValueOnce(ok());
    renderDetail();
    await userEvent.click(await screen.findByRole("button", { name: "Download encrypted copy" }));
    expect(await screen.findByText("Download started")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]![0]).toContain(`/api/backup/archives/${ID}/download`);
    expect(clickSpy).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(10), { status: 200, headers: { "content-disposition": "attachment; filename=x.rpbk" } }));
    await userEvent.click(screen.getByRole("button", { name: "Download encrypted copy" }));
    expect(await screen.findByText("Incomplete download")).toBeInTheDocument();
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("places and releases legal holds with reason codes", async () => {
    const createHold = vi.fn(() => ({}));
    const releaseHold = vi.fn(() => ({ ok: true }));
    handlers["backup.admin.createHold"] = createHold;
    handlers["backup.admin.releaseHold"] = releaseHold;
    handlers["backup.admin.detail"] = () => detail({ holds: [{ publicId: "hold_synthetic_01", backupPublicId: ID, reasonCode: "LITIGATION", note: "Matter 42", createdByUserPublicId: null, createdAt: NOW, releasedAt: null }] });
    const { container } = renderDetail();
    expect(await screen.findByText("Matter 42")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "How to restore" })).toHaveAttribute("href", "/admin/backups/restore");

    await userEvent.click(screen.getByRole("button", { name: "Place legal hold" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Place hold" }));
    expect(await within(dialog).findByText(/at least 3 characters/u)).toBeInTheDocument();
    await userEvent.selectOptions(within(dialog).getByLabelText(/Reason/u), "REGULATORY_INQUIRY");
    await userEvent.type(within(dialog).getByLabelText(/Reference note/u), "Ticket 7");
    await expectNoAxeViolations(container);
    await userEvent.click(within(dialog).getByRole("button", { name: "Place hold" }));
    await waitFor(() => expect(createHold).toHaveBeenCalledWith({ backupPublicId: ID, reasonCode: "REGULATORY_INQUIRY", note: "Ticket 7" }));

    await userEvent.click(await screen.findByRole("button", { name: "Release legal hold LITIGATION" }));
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.selectOptions(within(confirm).getByLabelText(/Reason for release/u), "MATTER_CLOSED");
    await userEvent.click(within(confirm).getByRole("button", { name: "Release hold" }));
    await waitFor(() => expect(releaseHold).toHaveBeenCalledWith({ holdPublicId: "hold_synthetic_01", releaseReasonCode: "MATTER_CLOSED" }));
  });

  it("rejects malformed identifiers without calling the server", async () => {
    const spy = vi.fn(() => detail());
    handlers["backup.admin.detail"] = spy;
    renderUi(<BackupDetailRoute />, { path: "/admin/backups/bad%20id" });
    expect(await screen.findByText("Backup not found")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("Restore procedure page", () => {
  it("is read-only, explains the operator procedure and pre-fills the recommended backup", async () => {
    const mutations = vi.fn();
    handlers["backup.admin.restoreIsolated"] = mutations;
    const { container } = renderUi(<RestorePage />, { path: "/admin/backups/restore" });
    expect(await screen.findByRole("heading", { level: 1, name: "Restoring a backup" })).toBeInTheDocument();
    expect(screen.getByText(/Why restore is not a button here/u)).toBeInTheDocument();
    expect(await screen.findByText(new RegExp(`RESTORE ${ID} TO`, "u"))).toBeInTheDocument();
    expect(screen.getByText(/BACKUP_AND_RESTORE\.md/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(start|run|begin) restore/iu })).toBeNull();
    expect(mutations).not.toHaveBeenCalled();
    await expectNoAxeViolations(container);
  });

  it("warns when no verified backup exists", async () => {
    handlers["backup.admin.list"] = () => listPage([]);
    renderUi(<RestorePage />, { path: "/admin/backups/restore" });
    expect(await screen.findByText("No verified backup available")).toBeInTheDocument();
    expect(screen.getByText(/RESTORE <BACKUP_PUBLIC_ID> TO/u)).toBeInTheDocument();
  });
});

describe("Backup retention page", () => {
  beforeEach(() => {
    handlers["backup.admin.retentionPolicy"] = () => policy;
    handlers["backup.admin.previewRetention"] = () => ({ items: [
      { backupPublicId: ID, createdAt: NOW, action: "keep", keepReason: "last_known_good" },
      { backupPublicId: "bk_synthetic_0009", createdAt: new Date(NOW.getTime() - 200 * 86_400_000), action: "prune", keepReason: null },
    ] });
  });

  it("saves a validated policy", async () => {
    const update = vi.fn(() => ({ ok: true }));
    handlers["backup.admin.updateRetentionPolicy"] = update;
    const { container } = renderUi(<RetentionPage />);
    const keep = await screen.findByLabelText(/Keep at least/u);
    await userEvent.clear(keep);
    await userEvent.type(keep, "0");
    await userEvent.click(screen.getByRole("button", { name: "Save policy" }));
    expect(await screen.findByText(/whole number from 1 to 365/u)).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    await userEvent.clear(keep);
    await userEvent.type(keep, "30");
    await userEvent.click(screen.getByRole("switch", { name: /Automatic pruning/u }));
    await userEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ keepLastCount: 30, maxAgeDays: 90, scheduleEnabled: true, autoPruneEnabled: true }));
    await expectNoAxeViolations(container);
  });

  it("shows the plan and applies pruning only after typed confirmation", async () => {
    const runRetention = vi.fn(() => ({ prunedCount: 1, items: [] }));
    handlers["backup.admin.runRetention"] = runRetention;
    renderUi(<RetentionPage />);
    expect(await screen.findByText("1 backup(s) would be removed.")).toBeInTheDocument();
    expect(screen.getAllByText("Last verified good copy").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Apply retention" }));
    const dialog = await screen.findByRole("alertdialog");
    const confirmBtn = within(dialog).getByRole("button", { name: "Remove backups" });
    expect(confirmBtn).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("textbox"), "REMOVE");
    await userEvent.click(confirmBtn);
    await waitFor(() => expect(runRetention).toHaveBeenCalledWith({ dryRun: false }));
    expect(await screen.findByText("Retention applied")).toBeInTheDocument();
  });
});

/* wouter's useParams needs a matching <Route>. */
import { Route } from "wouter";
function BackupDetailRoute() {
  return <Route path="/admin/backups/:backupId"><BackupDetailPage /></Route>;
}
