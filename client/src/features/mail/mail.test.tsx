// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeResult } from "@/lib/authApi";
import { expectNoAxeViolations, fakeAuthApi, renderUi } from "@/ui/testing";
import EmailDeliveryPage from "./EmailDeliveryPage";
import type {
  AuditCopyVerificationStatus,
  GraphMailConfigView,
  MailTransportTestResult,
  PlatformSettingRow,
  SmtpConfigView,
} from "./model";
import { mailFeature } from "./routes";

const {
  mockState,
  updatePlatformSetting,
  updateSmtp,
  sendSmtpTest,
  updateGraph,
  sendGraphTest,
  requestAuditVerification,
  confirmAuditVerification,
} = vi.hoisted(() => ({
  mockState: {
    broken: false,
    auditVerified: false,
    auditAddress: "compliance-archive@example.test",
  },
  updatePlatformSetting: vi.fn(),
  updateSmtp: vi.fn(),
  sendSmtpTest: vi.fn(),
  updateGraph: vi.fn(),
  sendGraphTest: vi.fn(),
  requestAuditVerification: vi.fn(),
  confirmAuditVerification: vi.fn(),
}));

vi.mock("@/lib/trpc", () => {
  const checkedAt = new Date("2026-11-21T10:00:00Z");

  const makeSettings = (): PlatformSettingRow[] => [
    {
      key: "jobs.mail.sender",
      label: "Mail sender identity",
      description: "Shared outbound sender headers.",
      group: "jobs",
      kind: "value",
      value: {
        fromAddress: "noreply@readypackets.example.test",
        fromName: "ReadyPackets Portal",
        replyToAddress: "support@readypackets.example.test",
      },
      version: 2,
      updatedAt: checkedAt,
    },
    {
      key: "jobs.mail.routing",
      label: "Mail transport routing",
      description: "Primary and secondary transport.",
      group: "jobs",
      kind: "value",
      value: { primary: "smtp", secondary: "none" },
      version: 3,
      updatedAt: checkedAt,
    },
    {
      key: "jobs.mail.audit_copy",
      label: "Mail audit copy",
      description: "Redacted compliance mailbox copy.",
      group: "jobs",
      kind: "value",
      value: { enabled: true, address: mockState.auditAddress },
      version: 4,
      updatedAt: checkedAt,
    },
    {
      key: "jobs.mail.retain_content",
      label: "Retain message content",
      description: "Encrypted redacted content retention toggle.",
      group: "jobs",
      kind: "value",
      value: false,
      version: 1,
      updatedAt: null,
    },
    {
      key: "jobs.mail.retention_days",
      label: "Retention window",
      description: "Days to keep redacted message bodies.",
      group: "jobs",
      kind: "value",
      value: 30,
      version: 1,
      updatedAt: null,
    },
  ];

  const makeSmtp = (): SmtpConfigView => ({
    enabled: true,
    configured: true,
    verified: true,
    state: "configured",
    summary: "TLS relay configured on smtp.example.test:587.",
    host: "smtp.example.test",
    port: 587,
    tlsMode: "starttls",
    username: "mailer",
    passwordConfigured: true,
    fromAddress: "noreply@readypackets.example.test",
    fromName: "ReadyPackets Portal",
    replyToAddress: "",
    lastCheckedAt: checkedAt,
    lastOutcome: "succeeded",
  });

  const makeGraph = (): GraphMailConfigView => ({
    enabled: false,
    configured: true,
    verified: false,
    state: "configured",
    summary: "App credentials stored; test pending.",
    tenantId: "11111111-2222-3333-4444-555555555555",
    clientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    clientSecretConfigured: true,
    clientSecretLast4: "7q9z",
    senderMailbox: "mailer@tenant.example.test",
    egressPresetEnabled: true,
    egressReady: true,
    lastCheckedAt: null,
    lastOutcome: null,
    mailboxRestrictionNote:
      "Scope Mail.Send to mailer@tenant.example.test with Exchange Online RBAC for Applications.",
  });

  const makeAuditStatus = (): AuditCopyVerificationStatus => ({
    verified: mockState.auditVerified,
  });

  const stepUpGate = () => ({
    data: {
      safe: {
        domainCode: "STEP_UP_REQUIRED",
        safeMessage: "Fresh verification required.",
      },
    },
  });

  let verifiedStepUp = false;

  const trpcProxy = {
    platform: {
      admin: {
        settings: {
          list: {
            queryKey: () => ["platform", "settings", "list"],
            queryOptions: () => ({
              queryKey: ["platform", "settings", "list"],
              queryFn: async () => {
                if (mockState.broken) throw new Error("Settings backend unavailable");
                return makeSettings();
              },
            }),
          },
          update: {
            mutationOptions: (opts?: Record<string, unknown>) => ({
              ...opts,
              mutationFn: updatePlatformSetting,
            }),
          },
        },
      },
    },
    integrations: {
      admin: {
        smtp: {
          get: {
            queryKey: () => ["integrations", "smtp", "get"],
            queryOptions: () => ({
              queryKey: ["integrations", "smtp", "get"],
              queryFn: async () => {
                if (mockState.broken) throw new Error("SMTP status unavailable");
                return makeSmtp();
              },
            }),
          },
          update: {
            mutationOptions: (opts?: Record<string, unknown>) => ({
              ...opts,
              mutationFn: updateSmtp,
            }),
          },
          sendTest: {
            mutationOptions: (opts?: Record<string, unknown>) => ({
              ...opts,
              mutationFn: sendSmtpTest,
            }),
          },
        },
        graph: {
          get: {
            queryKey: () => ["integrations", "graph", "get"],
            queryOptions: () => ({
              queryKey: ["integrations", "graph", "get"],
              queryFn: async () => {
                if (mockState.broken) throw new Error("Graph status unavailable");
                return makeGraph();
              },
            }),
          },
          update: {
            mutationOptions: (opts?: Record<string, unknown>) => ({
              ...opts,
              mutationFn: updateGraph,
            }),
          },
          sendTest: {
            mutationOptions: (opts?: Record<string, unknown>) => ({
              ...opts,
              mutationFn: sendGraphTest,
            }),
          },
        },
      },
    },
    jobs: {
      mail: {
        auditCopy: {
          status: {
            queryKey: () => ["jobs", "mail", "auditCopy", "status"],
            queryOptions: () => ({
              queryKey: ["jobs", "mail", "auditCopy", "status"],
              queryFn: async () => {
                if (mockState.broken) throw new Error("Audit status unavailable");
                return makeAuditStatus();
              },
            }),
          },
          requestVerification: {
            mutationOptions: (opts?: Record<string, unknown>) => ({
              ...opts,
              mutationFn: requestAuditVerification,
            }),
          },
          confirmVerification: {
            mutationOptions: (opts?: Record<string, unknown>) => ({
              ...opts,
              mutationFn: confirmAuditVerification,
            }),
          },
        },
      },
    },
  };

  const clientProxy = {
    platform: {
      admin: {
        settings: {
          update: {
            mutate: async (input: unknown) => {
              if (!verifiedStepUp) {
                verifiedStepUp = true;
                throw stepUpGate();
              }
              return updatePlatformSetting(input);
            },
          },
        },
      },
    },
    integrations: {
      admin: {
        smtp: {
          update: {
            mutate: async (input: unknown) => {
              if (!verifiedStepUp) {
                verifiedStepUp = true;
                throw stepUpGate();
              }
              return updateSmtp(input);
            },
          },
          sendTest: {
            mutate: async (input: unknown) => {
              if (!verifiedStepUp) {
                verifiedStepUp = true;
                throw stepUpGate();
              }
              return sendSmtpTest(input);
            },
          },
        },
        graph: {
          update: {
            mutate: async (input: unknown) => {
              if (!verifiedStepUp) {
                verifiedStepUp = true;
                throw stepUpGate();
              }
              return updateGraph(input);
            },
          },
          sendTest: {
            mutate: async (input: unknown) => {
              if (!verifiedStepUp) {
                verifiedStepUp = true;
                throw stepUpGate();
              }
              return sendGraphTest(input);
            },
          },
        },
      },
    },
    jobs: {
      mail: {
        auditCopy: {
          requestVerification: {
            mutate: async () => {
              if (!verifiedStepUp) {
                verifiedStepUp = true;
                throw stepUpGate();
              }
              return requestAuditVerification();
            },
          },
          confirmVerification: {
            mutate: async (input: unknown) => {
              if (!verifiedStepUp) {
                verifiedStepUp = true;
                throw stepUpGate();
              }
              return confirmAuditVerification(input);
            },
          },
        },
      },
    },
    __resetStepUp: () => {
      verifiedStepUp = false;
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
    status: "authenticated",
    user: {
      publicId: "01JAFJ8VEGZ9GPVRR2S9KTYZMA",
      email: "admin@readypackets.example.test",
      name: "Portal Admin",
      role: "admin",
    },
    assurance: { mfaVerified: true, recentStepUp: false },
  };
}

async function completeStepUpDialog() {
  const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
  fireEvent.change(within(dialog).getByLabelText(/Current password/), {
    target: { value: "correct-horse-battery-staple" },
  });
  fireEvent.change(within(dialog).getByLabelText(/Authenticator code/), {
    target: { value: "123456" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Verify and continue" }));
}

describe("E-mail delivery administration UI", () => {
  beforeEach(async () => {
    mockState.broken = false;
    mockState.auditVerified = false;
    mockState.auditAddress = "compliance-archive@example.test";
    updatePlatformSetting.mockReset().mockResolvedValue({ ok: true });
    updateSmtp.mockReset().mockResolvedValue({});
    sendSmtpTest.mockReset().mockResolvedValue({
      outcome: "accepted",
      safeMessage: "Relay accepted test message for admin@readypackets.example.test.",
      checkedAt: new Date("2026-11-21T10:05:00Z"),
    } satisfies MailTransportTestResult);
    updateGraph.mockReset().mockResolvedValue({});
    sendGraphTest.mockReset().mockResolvedValue({
      outcome: "unknown",
      safeMessage: "Connection timed out after submission; delivery is unconfirmed.",
      checkedAt: new Date("2026-11-21T10:06:00Z"),
    } satisfies MailTransportTestResult);
    requestAuditVerification.mockReset().mockResolvedValue({ queued: true });
    confirmAuditVerification.mockReset().mockImplementation(async () => {
      mockState.auditVerified = true;
      return { verified: true };
    });
    const trpcMod = await import("@/lib/trpc");
    (trpcMod.useTRPCClient() as unknown as { __resetStepUp: () => void }).__resetStepUp();
  });

  afterEach(() => {
    cleanup();
  });

  it("registers /admin/email-delivery under Integrations console nav with mail.manage capability", () => {
    expect(mailFeature.routes[0]).toMatchObject({
      path: "/admin/email-delivery",
      title: "E-mail delivery",
      access: "admin",
      capability: "mail.manage",
    });
    expect(mailFeature.nav?.[0]).toMatchObject({
      label: "E-mail delivery",
      href: "/admin/email-delivery",
      area: "console",
      group: "Integrations",
      order: 60,
      access: "admin",
      capability: "mail.manage",
    });
  });

  it("renders sender, routing, SMTP form + test, enforces port 25 rejection & step-up MFA, and has no axe violations", async () => {
    const stepUp = vi.fn().mockResolvedValue(undefined);
    const { container } = renderUi(<EmailDeliveryPage />, {
      path: "/admin/email-delivery",
      api: fakeAuthApi({ me: async () => adminSession(), stepUp }),
    });

    expect(await screen.findByRole("heading", { level: 1, name: "E-mail delivery" })).toBeTruthy();
    expect(await screen.findByLabelText("SMTP host")).toHaveProperty("value", "smtp.example.test");
    // Secrets are never echoed
    expect(screen.getByLabelText("SMTP password")).toHaveProperty("value", "");
    await expectNoAxeViolations(container);

    // Block port 25 on SMTP before calling server
    fireEvent.change(screen.getByLabelText("SMTP port"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save SMTP settings" }));
    expect(await screen.findByText(/Port 25 is forbidden/)).toBeTruthy();
    expect(updateSmtp).not.toHaveBeenCalled();

    // Fix port to 465, save with step-up
    fireEvent.change(screen.getByLabelText("SMTP port"), { target: { value: "465" } });
    fireEvent.click(screen.getByRole("button", { name: "Save SMTP settings" }));
    await completeStepUpDialog();

    await waitFor(() => {
      expect(stepUp).toHaveBeenCalledTimes(1);
      expect(updateSmtp).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "smtp.example.test",
          port: 465,
          username: "mailer",
        }),
      );
    });

    // Send SMTP test to signed-in administrator ({})
    fireEvent.click(screen.getByRole("button", { name: "Send SMTP test to me" }));
    await waitFor(() => {
      expect(sendSmtpTest).toHaveBeenCalledWith({});
    });
    expect(await screen.findByText(/Relay accepted test message/)).toBeTruthy();
  });

  it("validates Microsoft Graph single-tenant GUIDs, preserves write-only secret discipline, and passes axe", async () => {
    const stepUp = vi.fn().mockResolvedValue(undefined);
    const { container } = renderUi(<EmailDeliveryPage />, {
      path: "/admin/email-delivery",
      api: fakeAuthApi({ me: async () => adminSession(), stepUp }),
    });

    await screen.findByLabelText("SMTP host");
    const graphTab = screen.getByRole("tab", { name: /Microsoft Graph/ });
    fireEvent.mouseDown(graphTab, { button: 0 });
    fireEvent.click(graphTab);

    const tenantInput = await screen.findByLabelText(/Directory \(tenant\) ID/);
    expect(tenantInput).toHaveProperty("value", "11111111-2222-3333-4444-555555555555");
    expect(screen.getByLabelText("Client secret")).toHaveProperty("value", "");
    expect(screen.getByText(/ends in …7q9z/)).toBeTruthy();
    await expectNoAxeViolations(container);

    // Reject multi-tenant 'common' alias
    fireEvent.change(tenantInput, { target: { value: "common" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Microsoft Graph settings" }));
    expect(await screen.findByText(/Multi-tenant aliases \(common, organizations, consumers\) are not allowed/)).toBeTruthy();
    expect(updateGraph).not.toHaveBeenCalled();

    // Restore valid tenant GUID and rotate secret
    fireEvent.change(tenantInput, { target: { value: "11111111-2222-3333-4444-555555555555" } });
    fireEvent.change(screen.getByLabelText("Client secret"), {
      target: { value: "rotated-graph-secret-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Microsoft Graph settings" }));
    await completeStepUpDialog();

    await waitFor(() => {
      expect(updateGraph).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "11111111-2222-3333-4444-555555555555",
          clientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          senderMailbox: "mailer@tenant.example.test",
          clientSecret: "rotated-graph-secret-value",
        }),
      );
    });

    // Run Graph test and ensure unknown outcome is rendered honestly (never as failed)
    fireEvent.click(screen.getByRole("button", { name: "Send Graph test to me" }));
    expect(await screen.findByText(/Outcome unknown — the transport did not confirm acceptance/)).toBeTruthy();
  });

  it("drives audit mailbox verification and bounded content retention (0–90 days)", async () => {
    const stepUp = vi.fn().mockResolvedValue(undefined);
    renderUi(<EmailDeliveryPage />, {
      path: "/admin/email-delivery",
      api: fakeAuthApi({ me: async () => adminSession(), stepUp }),
    });

    expect(await screen.findByText("Verification required")).toBeTruthy();

    // Request verification code (triggers step-up on first privileged call)
    fireEvent.click(screen.getByRole("button", { name: "Send verification code" }));
    await completeStepUpDialog();
    await waitFor(() => {
      expect(requestAuditVerification).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText(/verification code has been queued/)).toBeTruthy();

    // Confirm verification code
    fireEvent.change(screen.getByLabelText("Verification code"), {
      target: { value: "849201" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm verification code" }));
    await waitFor(() => {
      expect(confirmAuditVerification).toHaveBeenCalledWith({ code: "849201" });
    });
    expect(await screen.findByText("Verified mailbox")).toBeTruthy();

    // Validate retention bounds > 90 rejected, then save valid 14 days + toggle on
    fireEvent.change(screen.getByLabelText("Retention window (days)"), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Save retention settings" }));
    expect(await screen.findByText(/between 0 and 90/)).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Retain redacted message content" }));
    fireEvent.change(screen.getByLabelText("Retention window (days)"), { target: { value: "14" } });
    fireEvent.click(screen.getByRole("button", { name: "Save retention settings" }));

    await waitFor(() => {
      expect(updatePlatformSetting).toHaveBeenCalledWith({
        key: "jobs.mail.retain_content",
        expectedVersion: 1,
        value: true,
      });
      expect(updatePlatformSetting).toHaveBeenCalledWith({
        key: "jobs.mail.retention_days",
        expectedVersion: 1,
        value: 14,
      });
    });
  });

  it("renders ErrorState rather than unconfigured/empty state when queries fail", async () => {
    mockState.broken = true;
    renderUi(<EmailDeliveryPage />, {
      path: "/admin/email-delivery",
      api: fakeAuthApi({ me: async () => adminSession() }),
    });

    expect(await screen.findByText("Could not load e-mail delivery settings")).toBeTruthy();
    expect(screen.queryByLabelText("SMTP host")).toBeNull();
  });
});
