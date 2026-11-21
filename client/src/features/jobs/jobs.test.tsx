import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { ReactElement } from "react";
import superjson from "superjson";
import { describe, expect, it, vi } from "vitest";
import { Route } from "wouter";
import type { AppRouter } from "@server/trpc/root";
import { RouteFocus } from "@/app/RouteFocus";
import { TRPCProvider } from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { createTestQueryClient, expectNoAxeViolations, renderUi } from "@/ui/testing";
import { CustomerMaintenanceBanner } from "./CustomerMaintenanceBanner";
import JobDetailPage from "./pages/JobDetailPage";
import JobsPage from "./pages/JobsPage";
import MailPage from "./pages/MailPage";
import MaintenancePage from "./pages/MaintenancePage";
import SchedulesPage from "./pages/SchedulesPage";

const jobId = "01JD0000000000000000000001";
const mailId = "01JD0000000000000000000002";
const date = new Date("2026-11-20T12:00:00.000Z");
const customerOff = { enabled: false, message: "", startsAt: null, endsAt: null, active: false, phase: "off", version: 0 };
const workerOpen = { active: false, running: 0, unresolved: 0, state: "open" };

function renderConsole(page: ReactElement, records: Record<string, (input: unknown) => unknown>, path?: string) {
  const queryClient = createTestQueryClient();
  const client = createTRPCClient<AppRouter>({
    links: [httpBatchLink({
      url: "https://portal.example.test/rpc",
      transformer: superjson,
      fetch: async (request, init) => {
        const url = new URL(String(request));
        const data = JSON.parse((typeof init?.body === "string" ? init.body : url.searchParams.get("input")) || "{}") as
          Record<string, Parameters<typeof superjson.deserialize>[0]>;
        const paths = url.pathname.slice("/rpc/".length).split(",");
        const result = paths.map((path, index) => {
          const respond = records[path];
          if (!respond) throw new Error(`Unexpected test request: ${path}`);
          const input = data[index] === undefined ? undefined : superjson.deserialize(data[index]!);
          return { result: { data: superjson.serialize(respond(input)) } };
        });
        return Response.json(result);
      },
    })],
  });
  return renderUi(page, {
    queryClient, path, wrapper: (ui) => <TRPCProvider trpcClient={client} queryClient={queryClient}>{ui}</TRPCProvider>,
  });
}

describe("Jobs administration pages", () => {
  it("displays unknown outcomes distinctly in the list and links to job details", async () => {
    renderConsole(<JobsPage />, {
      "jobs.admin.list": () => ({
        items: [{ publicId: jobId, type: "test.delivery", state: "unknown", attempt: 1, maxAttempts: 1, updatedAt: date }],
        nextCursor: null,
      }),
    });
    const table = await screen.findByRole("table", { name: "Background jobs" });
    expect(within(table).getByText("Unknown outcome")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: `Details for job ${jobId}` })).toHaveAttribute("href", `/admin/jobs/${jobId}`);
    await expectNoAxeViolations();
  });

  it("gives the unknown job an audit link and does not offer retry", async () => {
    renderConsole(<Route path="/admin/jobs/:jobId" component={JobDetailPage} />, {
      "jobs.admin.detail": () => ({
        publicId: jobId, type: "job.external", state: "unknown", correlationId: "workflow_one",
        attempt: 1, maxAttempts: 1, createdAt: date, updatedAt: date, runAt: date, reconciledAt: null,
        attempts: [{ attempt: 1, state: "interrupted", reasonCode: "JOB_LEASE_EXPIRED", startedAt: date, finishedAt: date }],
      }),
    }, `/admin/jobs/${jobId}`);
    expect(await screen.findByRole("link", { name: "View audit trail" })).toHaveAttribute("href", "/admin/audit?correlationId=workflow_one");
    expect(screen.getByRole("button", { name: "Record reconciliation" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry job" })).not.toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it("shows holds and provider acceptance distinctly and offers resend only for held mail", async () => {
    renderConsole(<MailPage />, {
      "jobs.admin.listMail": () => ({
        items: [
          { publicId: mailId, template: "test.held", state: "held", canResend: true, updatedAt: date },
          { publicId: jobId, template: "test.accepted", state: "accepted", canResend: false, updatedAt: date },
        ],
        nextCursor: null,
      }),
    });
    const table = await screen.findByRole("table", { name: "Outgoing mail" });
    expect(within(table).getByText("Held: mail not configured")).toBeInTheDocument();
    expect(within(table).getByText("Provider accepted")).toBeInTheDocument();
    expect(within(table).getByRole("button", { name: `Resend message ${mailId}` })).toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: `Resend message ${jobId}` })).not.toBeInTheDocument();
    expect(screen.getByText("Acceptance is not delivery")).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it("warns about duplicates before explicitly resending unknown mail and labels the queued attempt", async () => {
    const user = userEvent.setup();
    const resend = vi.fn(() => ({ jobId }));
    renderConsole(<MailPage />, {
      "jobs.admin.listMail": () => ({
        items: [{ publicId: mailId, template: "test.unknown", state: "unknown", generation: 1,
          correlationId: "test_mail", canResend: true, updatedAt: date }], nextCursor: null,
      }),
      "jobs.admin.resend": resend,
      "jobs.admin.mailDetail": () => ({ attempts: [{
        generation: 2, purpose: "manual_resend_after_unknown", transport: null, state: "queued", finishedAt: date,
      }] }),
    });
    const outgoing = await screen.findByRole("table", { name: "Outgoing mail" });
    await user.click(within(outgoing).getByRole("button", { name: `Resend message ${mailId}` }));
    const dialog = screen.getByRole("alertdialog", { name: "Resend after an unknown outcome?" });
    expect(within(dialog).getByText(/recipient may receive the message twice/i)).toBeVisible();
    expect(resend).not.toHaveBeenCalled();
    await expectNoAxeViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Acknowledge risk and queue resend" }));
    expect(await screen.findByText(/it has not been sent/i)).toBeVisible();
    expect(resend).toHaveBeenCalledExactlyOnceWith({ publicId: mailId, expectedGeneration: 1, acknowledgeDuplicateRisk: true });
    await user.click(within(outgoing).getByRole("button", { name: `Attempts for message ${mailId}` }));
    const history = await screen.findByRole("table", { name: "Message attempt history" });
    expect(await within(history).findByText("Manual resend after unknown outcome")).toBeVisible();
  });

  it("displays both retained bodies without interpreting HTML or caching the mutation", async () => {
    const user = userEvent.setup();
    const html = '<img src="https://remote.example.test/pixel"><a href="https://remote.example.test/">[REDACTED]</a>';
    const load = vi.fn(() => ({ to: "recipient@example.test", subject: "Retained", text: "[REDACTED]", html }));
    const view = renderConsole(<MailPage />, {
      "jobs.admin.listMail": () => ({
        items: [{ publicId: mailId, template: "test.retained", state: "accepted", canViewContent: true, updatedAt: date }],
        nextCursor: null,
      }),
      "jobs.mail.content": load,
    });
    const table = await screen.findByRole("table", { name: "Outgoing mail" });
    const opener = within(table).getByRole("button", { name: `View message ${mailId}` });
    expect(load).not.toHaveBeenCalled();
    await user.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Retained message" });
    expect(load).toHaveBeenCalledWith({ publicId: mailId });
    expect(within(dialog).getByRole("region", { name: "Plain-text body" })).toHaveTextContent("[REDACTED]");
    expect(within(dialog).getByRole("region", { name: "HTML source (not rendered)" })).toHaveTextContent(html);
    expect(dialog.querySelector("img,a,iframe")).toBeNull();
    expect(view.queryClient.getMutationCache().getAll()).toHaveLength(0);
    await expectNoAxeViolations();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Retained message" })).not.toBeInTheDocument();
  });

  it("reveals captured mail only on request and keeps it out of the mutation cache", async () => {
    const user = userEvent.setup();
    const load = vi.fn(() => ({ to: "preview@example.test", subject: "Preview", text: "<a>Example preview text</a>" }));
    const view = renderConsole(<MailPage />, {
      "jobs.admin.listMail": () => ({
        items: [{ publicId: mailId, template: "test.captured", state: "captured", canViewCapture: true, updatedAt: date }],
        nextCursor: null,
      }),
      "jobs.admin.capture": load,
    });
    const table = await screen.findByRole("table", { name: "Outgoing mail" });
    const opener = within(table).getByRole("button", { name: `View capture for message ${mailId}` });
    expect(load).not.toHaveBeenCalled();
    await user.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Captured mail" });
    expect(load).toHaveBeenCalledWith({ publicId: mailId });
    expect(within(dialog).getByText("<a>Example preview text</a>")).toBeInTheDocument();
    expect(within(dialog).queryByRole("link")).not.toBeInTheDocument();
    expect(view.queryClient.getMutationCache().getAll()).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByText("<a>Example preview text</a>")).not.toBeInTheDocument();
  });

  it("shows the next slot as paused while maintenance is on", async () => {
    renderConsole(<SchedulesPage />, {
      "jobs.admin.schedules": () => ({ paused: true, items: [{ name: "test.daily", everyMs: 86_400_000, nextSlot: date, last: null }] }),
    });
    const table = await screen.findByRole("table", { name: "Recurring work" });
    expect(within(table).getByText("Every 1 day")).toBeInTheDocument();
    expect(within(table).getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("Schedules paused")).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it("confirms before enabling maintenance and blocks reopening with unresolved work", async () => {
    const user = userEvent.setup();
    let active = false;
    const toggle = vi.fn((raw: unknown) => {
      expect(raw).toEqual({ active: true, expectedActive: false });
      active = true;
      return { active };
    });
    renderConsole(<MaintenancePage />, {
      "jobs.admin.maintenance": () => active
        ? { active, running: 0, unresolved: 1, state: "unproved" }
        : { active, running: 0, unresolved: 0, state: "open" },
      "jobs.admin.setMaintenance": toggle,
      "jobs.admin.customerMaintenance": () => customerOff,
    });
    await user.click(await screen.findByRole("button", { name: "Start maintenance" }));
    const dialog = screen.getByRole("alertdialog", { name: "Start maintenance?" });
    expect(toggle).not.toHaveBeenCalled();
    await expectNoAxeViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Start maintenance" }));
    expect(await screen.findByRole("button", { name: "End maintenance" })).toBeDisabled();
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Maintenance remains on")).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it("confirms customer access changes independently and explicitly confirms ending sessions", async () => {
    const user = userEvent.setup();
    let settings = customerOff;
    const save = vi.fn((input: unknown) => {
      expect(input).toEqual({ enabled: true, message: "Planned maintenance", startsAt: null, endsAt: null, expectedVersion: 0 });
      settings = { ...customerOff, enabled: true, active: true, message: "Planned maintenance", phase: "active", version: 1 };
      return settings;
    });
    const end = vi.fn(() => ({ ended: 3 }));
    renderConsole(<MaintenancePage />, {
      "jobs.admin.maintenance": () => workerOpen,
      "jobs.admin.customerMaintenance": () => settings,
      "jobs.admin.setCustomerMaintenance": save,
      "identity.admin.sessions.endAllCustomers": end,
    });
    await user.click(await screen.findByRole("checkbox", { name: "Enable customer maintenance" }));
    await user.type(screen.getByRole("textbox", { name: "Public message" }), "Planned maintenance");
    await user.click(screen.getByRole("button", { name: "Review customer access change" }));
    const review = screen.getByRole("alertdialog", { name: "Save customer maintenance settings?" });
    expect(save).not.toHaveBeenCalled();
    await expectNoAxeViolations(review);
    await user.click(within(review).getByRole("button", { name: "Save settings" }));
    const revoke = await screen.findByRole("button", { name: "End customer sessions now" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(end).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start maintenance" })).toBeEnabled();
    await user.click(revoke);
    const dialog = screen.getByRole("alertdialog", { name: "End all customer sessions?" });
    const confirm = within(dialog).getByRole("button", { name: "End customer sessions" });
    expect(confirm).toBeDisabled();
    await expectNoAxeViolations(dialog);
    await user.type(within(dialog).getByRole("textbox", { name: /type end customer sessions/i }), "END CUSTOMER SESSIONS");
    await user.click(confirm);
    expect(await screen.findByText("3 customer sessions ended.")).toBeVisible();
    expect(end).toHaveBeenCalledExactlyOnceWith({ reasonCode: "CUSTOMER_MAINTENANCE" });
  });

  it("renders customer maintenance status as inert text and includes the UTC expected end", async () => {
    renderConsole(<CustomerMaintenanceBanner />, {
      "jobs.maintenance.customerAccess": () => ({ active: true, message: "<img src=/public>", expectedEnd: date.toISOString() }),
    });
    const message = await screen.findByText("<img src=/public>");
    expect(message).toBeVisible();
    const banner = message.closest('[role="status"]');
    expect(banner).not.toBeNull();
    expect(banner?.querySelector("img")).toBeNull();
    expect(banner?.querySelector("time")).toHaveAttribute("datetime", date.toISOString());
  });

  pageA11y("Maintenance console and customer banner", async () => {
    renderConsole(<main id="main">
      <CustomerMaintenanceBanner />
      <MaintenancePage />
      <RouteFocus title="Maintenance" path="/admin/maintenance" />
    </main>, {
      "jobs.maintenance.customerAccess": () => ({ active: true, message: "Planned maintenance", expectedEnd: date.toISOString() }),
      "jobs.admin.maintenance": () => workerOpen,
      "jobs.admin.customerMaintenance": () => ({ ...customerOff, enabled: true, active: true, phase: "active" }),
    }, "/admin/maintenance");
    await screen.findByText("Planned maintenance");
    await screen.findByRole("button", { name: "End customer sessions now" });
  });
});
