// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ConsoleShell } from "@/app/shell/ConsoleShell";
import type { MeResult } from "@/lib/authApi";
import { expectNoAxeViolations, fakeAuthApi, renderUi } from "@/ui/testing";
import type {
  EgressPresetView,
  OrderSyncSettingsView,
  OrderSyncStatusRow,
  StorageAssignmentView,
  StorageConnectionView,
} from "./model";
import { SharePointOrderSyncPage } from "./SharePointOrderSyncPage";
import { StorageConnectionWizardPage } from "./StorageConnectionWizardPage";
import { resetConsumedOAuthHandlesForTest, StorageConnectionsPage } from "./StorageConnectionsPage";
import { storageFeature } from "./routes";

const {
  mockState,
  createConnection,
  updateConnection,
  testConnection,
  setAssignment,
  setEgressPreset,
  discoverSite,
  listDrives,
  listFolders,
  listOrderSyncLists,
  createOrderSyncList,
  updateOrderSync,
  testOrderSync,
  backfillOrders,
  resyncAllOrders,
  sessionFetchMock,
} = vi.hoisted(() => ({
  mockState: {
    broken: false,
    backfillFailed: false,
  },
  createConnection: vi.fn(),
  updateConnection: vi.fn(),
  testConnection: vi.fn(),
  setAssignment: vi.fn(),
  setEgressPreset: vi.fn(),
  discoverSite: vi.fn(),
  listDrives: vi.fn(),
  listFolders: vi.fn(),
  listOrderSyncLists: vi.fn(),
  createOrderSyncList: vi.fn(),
  updateOrderSync: vi.fn(),
  testOrderSync: vi.fn(),
  backfillOrders: vi.fn(),
  resyncAllOrders: vi.fn(),
  sessionFetchMock: vi.fn(),
}));

const sampleConnections: StorageConnectionView[] = [
  {
    publicId: "01JAFJ8VEGZ9GPVRR2S9KTYZS3",
    kind: "s3",
    name: "Primary AWS Archive",
    config: { preset: "aws", bucket: "rp-orders-prod", region: "us-east-1" },
    credentialsConfigured: true,
    oauthConnected: false,
    enabled: true,
    version: 3,
    lastTest: { ok: true, code: "OK", checkedAt: "2026-11-21T09:00:00Z" },
    createdAt: "2026-11-20T12:00:00Z",
    updatedAt: "2026-11-21T09:00:00Z",
  },
  {
    publicId: "01JAFJ8VEGZ9GPVRR2S9KTYZDB",
    kind: "dropbox",
    name: "Operations Dropbox",
    config: { clientId: "dbx-app-key-1", rootPath: "ReadyPackets" },
    credentialsConfigured: true,
    oauthConnected: true,
    enabled: false,
    version: 2,
    lastTest: { ok: true, code: "OK", checkedAt: "2026-11-21T09:15:00Z" },
    createdAt: "2026-11-20T12:00:00Z",
    updatedAt: "2026-11-21T09:15:00Z",
  },
  {
    publicId: "01JAFJ8VEGZ9GPVRR2S9KTYZSP",
    kind: "sharepoint",
    name: "Contoso Operations SharePoint",
    config: {
      tenantId: "11111111-2222-3333-4444-555555555555",
      clientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      siteUrl: "https://contoso.sharepoint.com/sites/Operations",
      siteId: "contoso.sharepoint.com,site-1,web-1",
      driveId: "b!drive-1",
      driveName: "Documents",
      rootFolderPath: "ReadyPackets",
    },
    credentialsConfigured: true,
    oauthConnected: false,
    enabled: true,
    version: 4,
    lastTest: { ok: true, code: "OK", checkedAt: "2026-11-21T09:30:00Z" },
    createdAt: "2026-11-20T12:00:00Z",
    updatedAt: "2026-11-21T09:30:00Z",
  },
];

const sampleAssignments: StorageAssignmentView[] = [
  { purpose: "order_files", connectionPublicId: "01JAFJ8VEGZ9GPVRR2S9KTYZS3" },
  { purpose: "backups", connectionPublicId: "01JAFJ8VEGZ9GPVRR2S9KTYZS3" },
  { purpose: "order_data", connectionPublicId: "01JAFJ8VEGZ9GPVRR2S9KTYZSP" },
];

const samplePresets: EgressPresetView[] = [
  {
    key: "amazon_s3",
    label: "Amazon S3 Regional Endpoint",
    purpose: "storage_s3",
    parameterized: true,
    hosts: ["s3.us-east-1.amazonaws.com"],
    enabled: true,
    matchingRulePublicIds: ["01JAFJ8VEGZ9GPVRR2S9KTYZRL"],
  },
  {
    key: "dropbox",
    label: "Dropbox API & Content Upload",
    purpose: "storage_dropbox",
    parameterized: false,
    hosts: ["api.dropboxapi.com", "content.dropboxapi.com"],
    enabled: true,
    matchingRulePublicIds: ["01JAFJ8VEGZ9GPVRR2S9KTYZRM"],
  },
];

function buildOrderSyncSettings(): OrderSyncSettingsView {
  return {
    enabled: true,
    connectionPublicId: "01JAFJ8VEGZ9GPVRR2S9KTYZSP",
    siteId: "contoso.sharepoint.com,site-1,web-1",
    siteLabel: "Contoso Operations",
    listId: "list-orders-1",
    listLabel: "ReadyPackets Orders",
    includePortalLink: true,
    version: 2,
    state: "ready",
    lastError: null,
    counts: { pending: 1, synced: 12, failed: 0 },
    backfill: mockState.backfillFailed
      ? {
          state: "failed",
          enqueued: 8,
          reasonCode: "SHAREPOINT_RATE_LIMITED",
          startedAt: "2026-11-21T09:40:00Z",
          finishedAt: "2026-11-21T09:41:00Z",
        }
      : null,
  };
}

const sampleSyncRows: OrderSyncStatusRow[] = [
  {
    orderPublicId: "01JAFJ8VEGZ9GPVRR2S9KTYZOR",
    reference: "ORD-2026-1042",
    state: "synced",
    attempts: 1,
    lastSyncedAt: "2026-11-21T09:50:00Z",
    reasonCode: null,
  },
  {
    orderPublicId: "01JAFJ8VEGZ9GPVRR2S9KTYZUK",
    reference: "ORD-2026-1043",
    state: "unknown",
    attempts: 1,
    lastSyncedAt: null,
    reasonCode: "SHAREPOINT_WRITE_OUTCOME_UNKNOWN",
  },
];

vi.mock("@/lib/sessionTransport", () => ({
  sessionFetch: (...args: unknown[]) => sessionFetchMock(...args),
}));

vi.mock("@/lib/trpc", () => {
  let verifiedStepUp = false;

  const failIfBroken = () => {
    if (mockState.broken) {
      throw Object.assign(new Error("Down"), {
        data: { safe: { domainCode: "UNAVAILABLE", safeMessage: "Storage service unavailable." } },
      });
    }
  };

  const stepUpGate = () =>
    Object.assign(new Error("Step-up required"), {
      data: {
        safe: {
          domainCode: "STEP_UP_REQUIRED",
          reasonCode: "STEP_UP_REQUIRED",
          safeMessage: "Step-up authentication is required.",
        },
      },
    });

  const trpcProxy = {
    storage: {
      connections: {
        list: {
          queryKey: (i?: unknown) => ["storage.connections.list", i] as const,
          queryOptions: (i?: unknown) => ({
            queryKey: ["storage.connections.list", i] as const,
            queryFn: async () => {
              failIfBroken();
              return { items: sampleConnections, nextCursor: null };
            },
          }),
        },
        get: {
          queryKey: (i?: { publicId: string }) => ["storage.connections.get", i] as const,
          queryOptions: (i?: { publicId: string }) => ({
            queryKey: ["storage.connections.get", i] as const,
            queryFn: async () => {
              failIfBroken();
              return sampleConnections[0]!;
            },
          }),
        },
        create: { mutationOptions: (o?: Record<string, unknown>) => ({ ...o, mutationFn: createConnection }) },
        update: { mutationOptions: (o?: Record<string, unknown>) => ({ ...o, mutationFn: updateConnection }) },
        test: { mutationOptions: (o?: Record<string, unknown>) => ({ ...o, mutationFn: testConnection }) },
      },
      assignments: {
        list: {
          queryKey: () => ["storage.assignments.list"] as const,
          queryOptions: () => ({
            queryKey: ["storage.assignments.list"] as const,
            queryFn: async () => {
              failIfBroken();
              return sampleAssignments;
            },
          }),
        },
        set: { mutationOptions: (o?: Record<string, unknown>) => ({ ...o, mutationFn: setAssignment }) },
      },
    },
    integrations: {
      admin: {
        egress: {
          presets: {
            queryKey: () => ["integrations.admin.egress.presets"] as const,
            queryOptions: () => ({
              queryKey: ["integrations.admin.egress.presets"] as const,
              queryFn: async () => {
                failIfBroken();
                return samplePresets;
              },
            }),
          },
        },
      },
    },
    sharepoint: {
      admin: {
        orderSync: {
          get: {
            queryKey: () => ["sharepoint.admin.orderSync.get"] as const,
            queryOptions: () => ({
              queryKey: ["sharepoint.admin.orderSync.get"] as const,
              queryFn: async () => {
                failIfBroken();
                return buildOrderSyncSettings();
              },
            }),
          },
          status: {
            queryKey: (i?: unknown) => ["sharepoint.admin.orderSync.status", i] as const,
            queryOptions: (i?: unknown) => ({
              queryKey: ["sharepoint.admin.orderSync.status", i] as const,
              queryFn: async () => {
                failIfBroken();
                return { items: sampleSyncRows, nextCursor: null };
              },
            }),
          },
        },
      },
    },
  };

  const guardMutate = <T extends (...args: never[]) => unknown>(fn: T) => ({
    mutate: async (...args: Parameters<T>) => {
      if (!verifiedStepUp) {
        verifiedStepUp = true;
        throw stepUpGate();
      }
      return fn(...args);
    },
  });

  const clientProxy = {
    __resetStepUp: () => {
      verifiedStepUp = false;
    },
    storage: {
      connections: {
        create: guardMutate(createConnection),
        update: guardMutate(updateConnection),
        test: guardMutate(testConnection),
      },
      assignments: {
        set: guardMutate(setAssignment),
      },
    },
    integrations: {
      admin: {
        egress: {
          setPreset: guardMutate(setEgressPreset),
        },
      },
    },
    sharepoint: {
      admin: {
        discoverSite: guardMutate(discoverSite),
        listDrives: { mutate: listDrives },
        resolveOneDrive: guardMutate(vi.fn()),
        listFolders: { mutate: listFolders },
        orderSync: {
          listLists: guardMutate(listOrderSyncLists),
          createList: guardMutate(createOrderSyncList),
          update: guardMutate(updateOrderSync),
          test: guardMutate(testOrderSync),
          backfill: guardMutate(backfillOrders),
          resyncAll: guardMutate(resyncAllOrders),
        },
      },
    },
  };

  return {
    useTRPC: () => trpcProxy,
    useTRPCClient: () => clientProxy,
    safeError: (err: { data?: { safe?: unknown } }) => err?.data?.safe,
    errorMessage: (err: { data?: { safe?: { safeMessage?: string } }; message?: string }, fallback = "Failed") =>
      err?.data?.safe?.safeMessage ?? err?.message ?? fallback,
  };
});

function adminSession(): MeResult {
  return {
    state: "full",
    pendingSteps: [],
    nextStep: null,
    user: {
      publicId: "01JAFJ8VEGZ9GPVRR2S9KTYZMA",
      email: "admin@readypackets.example.test",
      name: "Portal Admin",
      role: "admin",
      status: "active",
    },
  };
}

async function completeStepUpDialog() {
  const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
  fireEvent.change(within(dialog).getByLabelText(/^Password/), {
    target: { value: "correct-horse-battery-staple" },
  });
  fireEvent.change(within(dialog).getByLabelText(/6-digit code/), {
    target: { value: "123456" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Verify" }));
}

describe("Storage connections & SharePoint order sync UI", () => {
  beforeEach(async () => {
    mockState.broken = false;
    mockState.backfillFailed = false;
    resetConsumedOAuthHandlesForTest();
    window.history.replaceState(null, "", "/");
    createConnection.mockReset();
    updateConnection.mockReset().mockResolvedValue(sampleConnections[0]);
    testConnection.mockReset().mockResolvedValue({
      ...sampleConnections[0]!,
      lastTest: { ok: true, code: "OK", checkedAt: "2026-11-21T10:05:00Z" },
    });
    setAssignment.mockReset().mockResolvedValue(sampleAssignments);
    setEgressPreset.mockReset().mockResolvedValue(samplePresets[0]!);
    discoverSite.mockReset().mockResolvedValue({
      siteId: "contoso.sharepoint.com,site-1,web-1",
      displayName: "Contoso Operations",
      webUrl: "https://contoso.sharepoint.com/sites/Operations",
    });
    listDrives.mockReset().mockResolvedValue({
      drives: [{ driveId: "b!drive-1", name: "Documents", driveType: "documentLibrary" }],
    });
    listFolders.mockReset().mockResolvedValue({
      folders: [{ itemId: "folder-1", name: "Orders", path: "Orders" }],
      nextCursor: null,
    });
    listOrderSyncLists.mockReset().mockResolvedValue({
      lists: [
        { listId: "list-orders-1", displayName: "ReadyPackets Orders", compatible: true },
        { listId: "list-legacy", displayName: "Legacy Tasks", compatible: false },
      ],
    });
    createOrderSyncList.mockReset().mockResolvedValue({
      listId: "list-created-2",
      displayName: "Fulfillment Tracker",
    });
    updateOrderSync.mockReset().mockImplementation(async () => buildOrderSyncSettings());
    testOrderSync.mockReset().mockResolvedValue({ ok: true, code: "OK" });
    backfillOrders.mockReset().mockImplementation(async () => ({
      ...buildOrderSyncSettings(),
      backfill: {
        state: "running",
        enqueued: 14,
        reasonCode: null,
        startedAt: "2026-11-21T10:00:00Z",
        finishedAt: null,
      },
    }));
    resyncAllOrders.mockReset().mockResolvedValue({ enqueued: 12 });
    sessionFetchMock.mockReset().mockImplementation(async (url: string) => {
      if (url.includes("/api/csrf")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/api/storage/oauth/redirect-uri/")) {
        return new Response(
          JSON.stringify({ redirectUri: "https://portal.example.test/api/storage/oauth/callback/dropbox" }),
          { status: 200 },
        );
      }
      if (url.includes("/api/storage/oauth/finish")) {
        return new Response(JSON.stringify({ connected: true }), { status: 200 });
      }
      if (url.includes("/api/storage/oauth/disconnect")) {
        return new Response(JSON.stringify({ remoteRevoked: false }), { status: 200 });
      }
      return new Response(JSON.stringify({ authorizeUrl: "https://www.dropbox.com/oauth2/authorize?state=abc" }), {
        status: 200,
      });
    });

    const trpcMod = await import("@/lib/trpc");
    (trpcMod.useTRPCClient() as unknown as { __resetStepUp: () => void }).__resetStepUp();
  });

  afterEach(() => {
    cleanup();
  });

  it("registers storage, the nested Copy log, and sibling SharePoint sync without prefix collision", () => {
    expect(storageFeature.nav).toEqual([
      expect.objectContaining({
        label: "Storage connections",
        href: "/admin/storage",
        group: "Integrations",
        order: 63,
        capability: "storage.manage",
      }),
      expect.objectContaining({
        label: "SharePoint order sync",
        href: "/admin/sharepoint-sync",
        group: "Integrations",
        order: 64,
        capability: "storage.manage",
      }),
      expect.objectContaining({
        label: "Copy log",
        href: "/admin/storage/copies",
        group: "Integrations",
        capability: "storage.copies.read",
      }),
    ]);
    expect(storageFeature.routes.map((route) => route.path)).toEqual(expect.arrayContaining([
      "/admin/storage", "/admin/storage/copies", "/admin/sharepoint-sync",
    ]));

    const session = adminSession();
    if (!session.user) throw new Error("Expected a console test user");
    renderUi(<ConsoleShell user={session.user}><h1>Copy log page</h1></ConsoleShell>, {
      path: "/admin/storage/copies", api: fakeAuthApi({ me: async () => session }),
    });
    const nav = within(screen.getByRole("navigation", { name: "Console" }));
    expect(nav.getAllByRole("link", { current: "page" })).toEqual([nav.getByRole("link", { name: "Copy log" })]);
    expect(nav.getByRole("link", { name: "Storage connections" })).not.toHaveAttribute("aria-current");
    expect(nav.getByRole("link", { name: "SharePoint order sync" })).not.toHaveAttribute("aria-current");
  });

  it("completes two-step OAuth fragment finish, warns when remoteRevoked is false on Disconnect, saves backup destinations, and passes axe", async () => {
    const validHandle = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq"; // 43 chars
    window.history.replaceState(
      null,
      "",
      `/admin/storage?oauth=finish#oauth-attempt=${validHandle}`,
    );

    const stepUp = vi.fn().mockResolvedValue(undefined);
    const { container } = renderUi(<StorageConnectionsPage />, {
      path: "/admin/storage?oauth=finish",
      api: fakeAuthApi({ me: async () => adminSession(), stepUp }),
    });

    expect(await screen.findByRole("heading", { level: 1, name: "Storage connections" })).toBeTruthy();
    expect(await screen.findByText("OAuth authorization connected")).toBeTruthy();
    // Fragment and query were scrubbed immediately
    expect(window.location.hash).toBe("");
    // Pre-refreshed /api/csrf before POST /api/storage/oauth/finish
    expect(sessionFetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/csrf"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(sessionFetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/storage/oauth/finish"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ attemptHandle: validHandle }),
      }),
    );

    await expectNoAxeViolations(container);

    // Click Disconnect on Dropbox row -> remoteRevoked: false surfaces explicit provider-console notice
    fireEvent.click(screen.getAllByRole("button", { name: "Disconnect" })[0]!);
    expect(await screen.findByText(/Local token cleared — revoke access in Dropbox/)).toBeTruthy();

    // Save off-site backup destinations (triggers step-up on tRPC call)
    fireEvent.click(screen.getByRole("button", { name: "Save backup destinations" }));
    await completeStepUpDialog();
    await waitFor(() => {
      expect(setAssignment).toHaveBeenCalledWith({
        purpose: "backups",
        connectionPublicIds: ["01JAFJ8VEGZ9GPVRR2S9KTYZS3"],
      });
    });
  });

  it("steps through the 9-provider Wizard with provider-native fields, SharePoint discovery, and passes axe", async () => {
    const createdSharePoint: StorageConnectionView = {
      publicId: "01JAFJ8VEGZ9GPVRR2S9KTYZNW",
      kind: "sharepoint",
      name: "New SharePoint Docs",
      config: {
        tenantId: "11111111-2222-3333-4444-555555555555",
        clientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        siteUrl: "https://contoso.sharepoint.com/sites/Operations",
        siteId: "",
        driveId: "",
        driveName: "",
        rootFolderPath: "",
      },
      credentialsConfigured: true,
      oauthConnected: false,
      enabled: false,
      version: 1,
      lastTest: null,
      createdAt: "2026-11-21T10:00:00Z",
      updatedAt: "2026-11-21T10:00:00Z",
    };
    createConnection.mockResolvedValueOnce(createdSharePoint);
    const updatedSharePoint: StorageConnectionView = {
      ...createdSharePoint,
      version: 2,
      config: {
        ...createdSharePoint.config,
        siteId: "contoso.sharepoint.com,site-1,web-1",
        driveId: "b!drive-1",
        driveName: "Documents",
        rootFolderPath: "ReadyPackets",
      },
    };
    updateConnection.mockResolvedValueOnce(updatedSharePoint);
    testConnection.mockResolvedValueOnce({
      ...updatedSharePoint,
      lastTest: { ok: true, code: "OK", checkedAt: "2026-11-21T10:06:00Z" },
    });

    const stepUp = vi.fn().mockResolvedValue(undefined);
    const { container } = renderUi(<StorageConnectionWizardPage />, {
      path: "/admin/storage/new",
      api: fakeAuthApi({ me: async () => adminSession(), stepUp }),
    });

    // Verify all 9 provider options render in Step 1
    for (const label of [
      "Amazon S3",
      "Wasabi",
      "Backblaze B2",
      "Custom S3-compatible",
      "Azure Blob Storage",
      "Dropbox",
      "Google Drive",
      "SharePoint library",
      "OneDrive for Business",
    ]) {
      expect(await screen.findByText(label)).toBeTruthy();
    }
    await expectNoAxeViolations(container);

    // Select SharePoint library and continue to Step 2
    fireEvent.click(screen.getByRole("radio", { name: /SharePoint library/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to credentials" }));

    fireEvent.change(await screen.findByLabelText(/Connection display name/), {
      target: { value: "New SharePoint Docs" },
    });
    fireEvent.change(screen.getByLabelText(/Directory \(tenant\) ID/), {
      target: { value: "11111111-2222-3333-4444-555555555555" },
    });
    fireEvent.change(screen.getByLabelText(/Application \(client\) ID/), {
      target: { value: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    });
    fireEvent.change(screen.getByLabelText(/^Client secret/), {
      target: { value: "super-secret-entra-credential" },
    });
    fireEvent.change(screen.getByLabelText(/SharePoint site URL/), {
      target: { value: "https://contoso.sharepoint.com/sites/Operations" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save & continue" }));
    await completeStepUpDialog();

    await waitFor(() => {
      expect(createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "sharepoint",
          name: "New SharePoint Docs",
          credentials: { clientSecret: "super-secret-entra-credential" },
        }),
      );
    });

    // Step 3: Discover site & libraries, save library selection, and run Test connection
    fireEvent.click(await screen.findByRole("button", { name: "Discover site & libraries" }));
    expect(await screen.findByText(/Contoso Operations/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save library selection" }));
    await waitFor(() => {
      expect(updateConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          publicId: "01JAFJ8VEGZ9GPVRR2S9KTYZNW",
          credentials: { clientSecret: "super-secret-entra-credential" },
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connection test passed")).toBeTruthy();
    expect(testConnection).toHaveBeenCalledWith({
      publicId: "01JAFJ8VEGZ9GPVRR2S9KTYZNW",
      expectedVersion: 2,
    });
  });

  it("renders SharePointOrderSyncPage, supports Resume/Restart backfill, list creation, and passes axe", async () => {
    mockState.backfillFailed = true;
    const stepUp = vi.fn().mockResolvedValue(undefined);
    const { container } = renderUi(<SharePointOrderSyncPage />, {
      path: "/admin/sharepoint-sync",
      api: fakeAuthApi({ me: async () => adminSession(), stepUp }),
    });

    expect(await screen.findByRole("heading", { level: 1, name: "SharePoint order sync" })).toBeTruthy();
    expect((await screen.findAllByText("ORD-2026-1042")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Outcome unknown")).length).toBeGreaterThan(0);
    await expectNoAxeViolations(container);

    // Failed backfill exposes both Resume and Restart buttons
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await completeStepUpDialog();

    await waitFor(() => {
      expect(backfillOrders).toHaveBeenCalledWith({ restart: true });
    });

    // Create compatible list
    fireEvent.change(screen.getByLabelText(/Or create a new compatible SharePoint list/), {
      target: { value: "Fulfillment Tracker" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create compatible list" }));
    await waitFor(() => {
      expect(createOrderSyncList).toHaveBeenCalledWith({ displayName: "Fulfillment Tracker" });
    });
  });

  it("renders ErrorState rather than empty state when storage queries fail", async () => {
    mockState.broken = true;
    renderUi(<StorageConnectionsPage />, {
      path: "/admin/storage",
      api: fakeAuthApi({ me: async () => adminSession() }),
    });

    expect(await screen.findByText("Could not load storage connections")).toBeTruthy();
    expect(screen.queryByText("No external storage connections configured")).toBeNull();
  });
});
