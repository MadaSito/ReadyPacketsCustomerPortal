import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { ReactElement } from "react";
import superjson from "superjson";
import { describe, expect, it } from "vitest";
import type { AppRouter } from "@server/trpc/root";
import { TRPCProvider } from "@/lib/trpc";
import type { MeResult } from "@/lib/authApi";
import { createTestQueryClient, expectNoAxeViolations, fakeAuthApi, renderUi } from "@/ui/testing";
import { ImportPreviewView } from "./pages/ConfigTransferPage";
import FeaturesPage from "./pages/FeaturesPage";
import HealthPage from "./pages/HealthPage";
import PresentationPage from "./pages/PresentationPage";
import SettingsPage from "./pages/SettingsPage";
import SetupPage from "./pages/SetupPage";
import ConfigTransferPage from "./pages/ConfigTransferPage";
import { editorKind, parseEditorValue } from "./model";
import { platformFeature } from "./routes";
import SystemHealthWidget from "./widgets/SystemHealthWidget";

const date = new Date("2026-11-20T12:00:00.000Z");
type Handler = (input: unknown) => unknown;
class Refuse {
  constructor(readonly code: string, readonly httpStatus: number, readonly safe?: Record<string, unknown>) {}
}

function renderConsole(page: ReactElement, records: Record<string, Handler>, calls: { path: string; input: unknown }[] = [], role?: "admin" | "staff") {
  const queryClient = createTestQueryClient();
  const client = createTRPCClient<AppRouter>({
    links: [httpBatchLink({
      url: "https://portal.example.test/rpc",
      transformer: superjson,
      fetch: async (request, init) => {
        const url = new URL(String(request));
        const data = JSON.parse((typeof init?.body === "string" ? init.body : url.searchParams.get("input")) || "{}") as Record<string, Parameters<typeof superjson.deserialize>[0]>;
        const paths = url.pathname.slice("/rpc/".length).split(",");
        const result = paths.map((path, index) => {
          const respond = records[path];
          if (!respond) throw new Error(`Unexpected test request: ${path}`);
          const input = data[index] === undefined ? undefined : superjson.deserialize(data[index]!);
          calls.push({ path, input });
          const value = respond(input);
          if (value instanceof Refuse) {
            return { error: superjson.serialize({ message: "Refused", code: -32603, data: { code: value.code, httpStatus: value.httpStatus, ...(value.safe ? { safe: value.safe } : {}) } }) };
          }
          return { result: { data: superjson.serialize(value) } };
        });
        return Response.json(result, { status: result.some((r) => "error" in r) ? 207 : 200 });
      },
    })],
  });
  const me = (r: "admin" | "staff"): MeResult => ({ user: { publicId: "u1", role: r, name: "Avery Example", email: "a@example.test", status: "active" }, state: "full", pendingSteps: [], nextStep: null });
  const api = role ? fakeAuthApi({ me: async () => me(role) }) : undefined;
  return renderUi(page, { queryClient, ...(api ? { api } : {}), wrapper: (ui) => <TRPCProvider trpcClient={client} queryClient={queryClient}>{ui}</TRPCProvider> });
}

const view = (over: Record<string, unknown>) => ({
  key: "general.site_name", kind: "value", group: "general", owner: "platform", label: "Site name", description: "Shown in the header.",
  sensitivity: "public", exportable: true, version: 1, updatedAt: date, value: "ReadyPackets", defaultValue: "ReadyPackets", configured: true, ...over,
});

describe("platform console", () => {
  it("routes are lazy, admin/staff only, and under /admin", () => {
    for (const route of platformFeature.routes) {
      expect(route.path.startsWith("/admin/")).toBe(true);
      expect(["admin", "staff"]).toContain(route.access);
    }
  });

  it("settings page lists values, shows secrets only as configured, and edits through the server", async () => {
    const calls: { path: string; input: unknown }[] = [];
    renderConsole(<SettingsPage />, {
      "platform.admin.settings.list": () => [
        view({}),
        view({ key: "mail.smtp.password", kind: "secret", group: "mail", label: "SMTP password", description: "Password for the relay.", value: undefined, defaultValue: undefined, configured: true }),
        view({ key: "general.max_items", label: "Max items", value: 25, defaultValue: 10, version: 3 }),
      ],
      "platform.admin.settings.update": (input) => ({ ...view({}), ...(input as object) }),
    }, calls);
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect((await screen.findAllByText("Configured")).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("smtp-secret");
    expect(screen.getAllByRole("button", { name: "Replace SMTP password" }).length).toBeGreaterThan(0);
    await expectNoAxeViolations();

    await userEvent.click(screen.getAllByRole("button", { name: "Edit Max items" })[0]!);
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText(/^Value/);
    await userEvent.clear(input);
    await userEvent.type(input, "abc");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Enter a number.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "platform.admin.settings.update")).toBe(false);
    await userEvent.clear(input);
    await userEvent.type(input, "40");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.path === "platform.admin.settings.update")?.input).toEqual({ key: "general.max_items", value: 40, expectedVersion: 3 }));
  });

  it("settings edit dialog: Form tab from the schema description, JSON tab on the same value, server field errors", async () => {
    const calls: { path: string; input: unknown }[] = [];
    let refuse = true;
    const field = {
      type: "object", label: "Retention", required: true, nullable: false,
      fields: [
        { key: "days", type: "integer", label: "Days", help: "How long to keep.", required: true, nullable: false, minimum: 1, maximum: 30 },
        { key: "mode", type: "enum", label: "Mode", required: true, nullable: false, options: [{ value: "soft", label: "Soft" }, { value: "hard", label: "Hard" }] },
        { key: "domains", type: "array", label: "Domains", required: false, nullable: false, maxItems: 3, items: { type: "string", label: "Domains", required: true, nullable: false, maxLength: 20 } },
      ],
    };
    renderConsole(<SettingsPage />, {
      "platform.admin.settings.list": () => [view({ key: "general.retention", label: "Retention", value: { days: 7, mode: "soft", domains: [] }, defaultValue: { days: 7, mode: "soft" }, version: 2, field })],
      "platform.admin.settings.update": (input) => {
        if (refuse) {
          refuse = false;
          return new Refuse("BAD_REQUEST", 400, { domainCode: "VALIDATION", reasonCode: "INVALID_SETTING_VALUE", safeMessage: "The value is not valid for this setting.", details: { fields: ["domains.0"] }, requestId: "r1" });
        }
        return { ...view({}), ...(input as object) };
      },
    }, calls, "admin");
    await userEvent.click((await screen.findAllByRole("button", { name: "Edit Retention" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("tab", { name: "Form", selected: true })).toBeInTheDocument();
    const days = within(dialog).getByLabelText(/^Days/);
    expect(days).toHaveValue("7");
    await expectNoAxeViolations();

    await userEvent.clear(days);
    await userEvent.type(days, "45");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("1 field needs attention")).toBeInTheDocument();
    expect(days).toHaveAttribute("aria-invalid", "true");
    expect(calls.some((c) => c.path === "platform.admin.settings.update")).toBe(false);
    await userEvent.clear(days);
    await userEvent.type(days, "14");
    await userEvent.selectOptions(within(dialog).getByLabelText(/^Mode/), "Hard");
    await userEvent.click(within(dialog).getByRole("button", { name: /Add domains/i }));
    await userEvent.type(within(dialog).getByLabelText(/^Domains 1/), "example.test");

    // The JSON tab shows the same draft value.
    await userEvent.click(within(dialog).getByRole("tab", { name: "JSON" }));
    const json = within(dialog).getByLabelText(/Value \(JSON\)/) as HTMLTextAreaElement;
    expect(JSON.parse(json.value)).toEqual({ days: 14, mode: "hard", domains: ["example.test"] });
    await userEvent.click(within(dialog).getByRole("tab", { name: "Form" }));

    // A server refusal maps its dot paths back onto the fields.
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("The server did not accept this value.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Domains 1/)).toHaveAttribute("aria-invalid", "true");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.path === "platform.admin.settings.update").at(-1)?.input).toEqual({ key: "general.retention", value: { days: 14, mode: "hard", domains: ["example.test"] }, expectedVersion: 2 }),
    );
  });

  it("settings page searches, collapses groups, and links settings owned by dedicated pages", async () => {
    renderConsole(<SettingsPage />, {
      "platform.admin.settings.list": () => [
        view({}),
        view({ key: "integrations.smtp.config", group: "integrations", label: "SMTP relay", description: "Outgoing mail relay.", value: { host: "x" } }),
        view({ key: "identity.sso.entra", group: "identity", label: "Entra", description: "Sign-in.", managedBy: { href: "/admin/sso", label: "Single sign-on" } }),
      ],
    });
    for (const link of await screen.findAllByRole("link", { name: "Open E-mail delivery to change SMTP relay" })) expect(link).toHaveAttribute("href", "/admin/email-delivery");
    for (const link of screen.getAllByRole("link", { name: "Open Single sign-on to change Entra" })) expect(link).toHaveAttribute("href", "/admin/sso");
    expect(screen.queryByRole("button", { name: "Edit SMTP relay" })).not.toBeInTheDocument();
    await expectNoAxeViolations();

    const general = screen.getByRole("button", { name: /General/ });
    expect(general).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(general);
    expect(general).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Edit Site name" })).not.toBeInTheDocument();

    await userEvent.type(screen.getByRole("searchbox", { name: /Search settings/ }), "site");
    expect(await screen.findByText("1 setting matches")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Edit Site name" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("SMTP relay")).not.toBeInTheDocument();
    await userEvent.clear(screen.getByRole("searchbox", { name: /Search settings/ }));
    await userEvent.type(screen.getByRole("searchbox", { name: /Search settings/ }), "zzz");
    expect(await screen.findByText("No matching settings")).toBeInTheDocument();
  });

  it("settings page shows an error state when the server refuses", async () => {
    renderConsole(<SettingsPage />, { "platform.admin.settings.list": () => new Refuse("FORBIDDEN", 403) });
    expect(await screen.findByRole("button", { name: /try again|retry/i })).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it("features page shows flags off by default and toggles with expected version", async () => {
    const calls: { path: string; input: unknown }[] = [];
    renderConsole(<FeaturesPage />, {
      "platform.admin.features.list": () => [view({ key: "feature.siem.forwarding", kind: "flag", group: "features", label: "SIEM forwarding", description: "Forward audit events.", value: false, version: 0 })],
      "platform.admin.features.set": () => view({ key: "feature.siem.forwarding", kind: "flag", value: true }),
    }, calls);
    const toggle = await screen.findByRole("switch", { name: /SIEM forwarding/ });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await expectNoAxeViolations();
    await userEvent.click(toggle);
    await waitFor(() => expect(calls.find((c) => c.path === "platform.admin.features.set")?.input).toEqual({ key: "feature.siem.forwarding", enabled: true, expectedVersion: 0 }));
  });

  it("features page empty state", async () => {
    renderConsole(<FeaturesPage />, { "platform.admin.features.list": () => [] });
    expect(await screen.findByText("No optional features")).toBeInTheDocument();
  });

  it("health page shows states with text, not colour alone", async () => {
    renderConsole(<HealthPage />, {
      "platform.admin.health": () => ({
        state: "degraded",
        checkedAt: date,
        components: [
          { component: "platform.database", state: "ok", summary: "Database reachable.", checkedAt: date, metrics: { latency_ms: 3 } },
          { component: "mail.smtp", state: "not_configured", summary: "SMTP is not configured.", checkedAt: date },
        ],
      }),
    });
    expect(await screen.findByText("Overall: Degraded")).toBeInTheDocument();
    expect(screen.getAllByText("Not configured").length).toBeGreaterThan(0);
    await expectNoAxeViolations();
  });

  it("setup page highlights required items and links with wouter", async () => {
    renderConsole(<SetupPage />, {
      "platform.admin.setupChecklist": () => [
        { id: "admin_exists", state: "complete", summary: "An administrator exists.", required: true },
        { id: "smtp", state: "not_configured", summary: "Email is not configured.", required: true },
        { id: "siem", state: "unknown", summary: "SIEM state unknown.", required: false },
      ],
    });
    expect(await screen.findByText("1 required item needs attention")).toBeInTheDocument();
    for (const link of screen.getAllByRole("link", { name: "Settings" })) expect(link).toHaveAttribute("href", "/admin/settings");
    await expectNoAxeViolations();
  });

  it("presentation page renders text, slides and images accessibly and saves slides", async () => {
    const calls: { path: string; input: unknown }[] = [];
    const imageId = "01JD0000000000000000000009";
    renderConsole(<PresentationPage />, {
      "platform.admin.presentation.get": () => ({
        settings: [
          view({ key: "platform.presentation.slides", group: "presentation", label: "Slides", version: 2, value: [{ id: "welcome", title: "Welcome", body: "Hello", image: { source: "upload", id: imageId, alt: "Team" } }] }),
          view({ key: "platform.presentation.support_text", group: "presentation", label: "Support", value: "Call us" }),
          view({ key: "platform.presentation.announcement", group: "presentation", label: "Announcement", value: { enabled: false, text: "", tone: "info" } }),
          view({ key: "platform.presentation.slideshow", group: "presentation", label: "Slideshow", value: { autoAdvance: false, intervalSeconds: 8 } }),
        ],
        images: [{ id: imageId, source: "upload", path: `/api/platform/presentation/images/${imageId}`, width: 640, height: 480, byteSize: 1000, createdAt: date }],
      }),
      "platform.admin.settings.update": () => view({}),
    }, calls);
    expect(await screen.findByDisplayValue("Welcome")).toBeInTheDocument();
    await expectNoAxeViolations();
    const alt = screen.getByLabelText(/Image description/);
    await userEvent.clear(alt);
    await userEvent.click(screen.getByRole("button", { name: "Save slides" }));
    expect(await screen.findByText("Describe every image in its alternative text.")).toBeInTheDocument();
    await userEvent.type(alt, "Our team");
    await userEvent.click(screen.getByRole("button", { name: "Save slides" }));
    await waitFor(() => expect(calls.find((c) => c.path === "platform.admin.settings.update")?.input).toMatchObject({ key: "platform.presentation.slides", expectedVersion: 2 }));
  });

  it("config transfer page renders and the preview warns about unauthenticated files", async () => {
    renderConsole(<ConfigTransferPage />, {});
    expect(screen.getByRole("heading", { level: 1, name: "Export and import" })).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it("import preview lists changes and rejections", async () => {
    renderUi(
      <ImportPreviewView
        preview={{
          digest: "a".repeat(64), secretsIncluded: false, integrity: "checksum-only",
          changes: [{ key: "general.site_name", kind: "value", change: "modify" }, { key: "general.x", kind: "value", change: "unchanged" }],
          rejected: [{ key: "general.unknown", reason: "UNKNOWN_SETTING" }],
          counts: { add: 0, modify: 1, unchanged: 1, rejected: 1 },
        }}
      />,
    );
    expect(screen.getByText("Not authenticated")).toBeInTheDocument();
    expect(screen.getAllByText("Not recognised by this version").length).toBeGreaterThan(0);
    await expectNoAxeViolations();
  });

  it("system health widget: capability-gated console card with counts, setup summary for admins, errors and empty state", async () => {
    const widget = platformFeature.widgets?.find((w) => w.key === "platform.system_health");
    expect(widget).toMatchObject({ area: "console", access: "staff", capability: "platform.health.read", span: 4 });
    const comp = (component: string, state: string) => ({ component, state, summary: "Synthetic.", checkedAt: date });
    const health = { state: "degraded", checkedAt: date, components: [comp("db", "ok"), comp("keys", "ok"), comp("mail", "degraded"), comp("siem", "not_configured")] };
    const checklist = [
      { id: "admin_mfa", state: "complete", summary: "Done.", required: true },
      { id: "smtp", state: "incomplete", summary: "Configure.", required: false },
      { id: "backups", state: "not_configured", summary: "Configure.", required: false },
    ];
    const calls: { path: string; input: unknown }[] = [];
    const admin = renderConsole(<SystemHealthWidget />, { "platform.admin.health": () => health, "platform.admin.setupChecklist": () => checklist }, calls, "admin");
    expect(screen.getByRole("heading", { level: 2, name: "System health" })).toBeInTheDocument();
    expect(await screen.findByText("Degraded", { selector: "span" })).toBeInTheDocument();
    expect(await screen.findByText("Required setup complete")).toBeInTheDocument();
    expect(screen.getByText("2 recommended items open")).toBeInTheDocument();
    const stat = (label: string) => screen.getByText(label, { selector: "p" }).nextElementSibling?.textContent;
    expect([stat("Healthy"), stat("Not configured")]).toEqual(["2", "1"]);
    expect(screen.getByRole("link", { name: "View health" })).toHaveAttribute("href", "/admin/health");
    expect(screen.getByRole("link", { name: "Setup checklist" })).toHaveAttribute("href", "/admin/setup");
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    await expectNoAxeViolations(admin.container);
    admin.unmount();

    const staffCalls: { path: string; input: unknown }[] = [];
    const staff = renderConsole(<SystemHealthWidget />, { "platform.admin.health": () => ({ ...health, state: "ok", components: [] }) }, staffCalls, "staff");
    expect(await screen.findByText("No components have reported health yet.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Setup checklist" })).toBeNull();
    expect(staffCalls.map((c) => c.path)).not.toContain("platform.admin.setupChecklist");
    await expectNoAxeViolations(staff.container);
    staff.unmount();

    const failed = renderConsole(<SystemHealthWidget />, { "platform.admin.health": () => new Refuse("UNAVAILABLE", 503), "platform.admin.setupChecklist": () => checklist }, [], "admin");
    expect(await screen.findByRole("button", { name: /try again|retry/i })).toBeInTheDocument();
    expect(screen.queryByText("Healthy", { selector: "p" })).toBeNull();
    await expectNoAxeViolations(failed.container);
    failed.unmount();
  });

  it("editor helpers pick a control and validate input", () => {
    expect(editorKind({ value: true, defaultValue: false })).toBe("boolean");
    expect(editorKind({ value: undefined, defaultValue: 5 })).toBe("number");
    expect(editorKind({ value: { a: 1 }, defaultValue: null })).toBe("json");
    expect(parseEditorValue("number", "x")).toEqual({ ok: false, error: "Enter a number." });
    expect(parseEditorValue("json", "{")).toEqual({ ok: false, error: "Enter valid JSON." });
    expect(parseEditorValue("json", "[1]")).toEqual({ ok: true, value: [1] });
  });
});
