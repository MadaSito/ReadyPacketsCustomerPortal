import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { ReactElement } from "react";
import superjson from "superjson";
import { describe, expect, it, vi } from "vitest";
import { Route } from "wouter";
import type { AppRouter } from "@server/trpc/root";
import { TRPCProvider } from "@/lib/trpc";
import { createTestQueryClient, expectNoAxeViolations, renderUi } from "@/ui/testing";
import JobDetailPage from "./pages/JobDetailPage";
import JobsPage from "./pages/JobsPage";
import MailPage from "./pages/MailPage";
import MaintenancePage from "./pages/MaintenancePage";
import SchedulesPage from "./pages/SchedulesPage";

const jobId = "01JD0000000000000000000001";
const mailId = "01JD0000000000000000000002";
const date = new Date("2026-11-20T12:00:00.000Z");

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

  it("shows held and SMTP acceptance distinctly and offers resend only for held mail", async () => {
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
    expect(within(table).getByText("SMTP accepted")).toBeInTheDocument();
    expect(within(table).getByRole("button", { name: `Resend message ${mailId}` })).toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: `Resend message ${jobId}` })).not.toBeInTheDocument();
    expect(screen.getByText("Acceptance is not delivery")).toBeInTheDocument();
    await expectNoAxeViolations();
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
});
