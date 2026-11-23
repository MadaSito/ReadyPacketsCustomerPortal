import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { pageA11y } from "@/test/a11y";
import { renderWithTrpc } from "../acceptance/testkit";
import { EndPolicySessionsAction } from "./PolicyEnforcementCards";
import { PolicyEnforcementPrompt, PolicyEnforcementRemediation } from "./PolicyEnforcementPrompt";
import { PolicyNoticeCard } from "./PolicyNoticeCard";

const item = {
  title: "Production agreement", versionLabel: "2.0", versionPublicId: "01JD0000000000000000000402",
  contentHash: "a".repeat(64), contentFormat: "plain_text", bodyText: "Exact synthetic policy text.",
  changeSummary: "The synthetic agreement was revised.", deadline: new Date(Date.now() + 60 * 60 * 1000),
  warningText: "Review {policy}. Time left: {timeLeft}.", requiresTypedSignature: true, blocking: false,
};

// eslint-disable-next-line no-restricted-properties -- Test-only inspection of the tab-scoped policy snooze preference.
const testStorage = window.sessionStorage;
beforeEach(() => { testStorage.clear(); });

function Host({ children }: { children: ReactNode }) {
  useEffect(() => { document.title = "Policies | ReadyPackets"; }, []);
  return <main><h1>Policies</h1><button type="button">Portal control</button>{children}</main>;
}

function grace(policy = item) {
  return renderWithTrpc(<Host><PolicyEnforcementPrompt /></Host>, {
    "compliance.policies.enforcement.pending": () => [policy],
    "compliance.policies.myStatus": () => ({ pendingRequired: [] }),
  }, { role: "customer" });
}

const informationalPolicy = { ...item, versionNumber: 2, effectiveAt: new Date("2026-11-20T12:00:00Z") };
function informational(current: () => (typeof informationalPolicy)[]) {
  return renderWithTrpc(<Host><PolicyEnforcementPrompt /></Host>, {
    "compliance.policies.enforcement.pending": () => [],
    "compliance.policies.myStatus": () => ({ pendingRequired: current() }),
  }, { role: "customer" });
}

function remediation(rejectName = false) {
  let accepted = false;
  return renderWithTrpc(<Host><PolicyEnforcementRemediation /></Host>, {
    "compliance.policies.enforcement.pending": () => accepted ? [] : [{ ...item, blocking: true }],
    "compliance.policies.enforcement.accept": () => {
      if (rejectName) throw { safe: {
        code: "VALIDATION_FAILED", reasonCode: "SIGNER_NAME_MISMATCH",
        safeMessage: "The typed signature must match your account profile name.", details: { expectedName: "Avery Updated Name" },
      } };
      accepted = true;
      return { accepted: true };
    },
  }, { role: "customer" });
}

it("enters the grace dialog, moves keyboard focus into policy review, and dismisses by Escape", async () => {
  grace();
  const dialog = await screen.findByRole("dialog", { name: "An updated policy needs your attention" });
  const read = within(dialog).getByRole("button", { name: "Read and accept" });
  expect(dialog.contains(document.activeElement)).toBe(true);
  read.focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(screen.getByText("Policy text and acceptance")).toHaveFocus());
  expect(within(dialog).getByRole("region", { name: "Production agreement, version 2.0, full text" })).toHaveTextContent(item.bodyText);
  expect(within(dialog).getByRole("button", { name: "Accept this version" })).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("snoozes the same exact informational versions across navigation and remounts, but prompts for a new version", async () => {
  const second = { ...informationalPolicy, title: "Privacy policy", versionPublicId: "01JD0000000000000000000410" };
  let versions = [informationalPolicy, second];
  const first = informational(() => versions);
  const title = "Updated policies need your review";
  const dialog = await screen.findByRole("dialog", { name: title });
  await userEvent.click(within(dialog).getByRole("button", { name: "Later" }));
  const banner = await screen.findByRole("region", { name: "Policy review reminder" });
  expect(banner).not.toHaveAttribute("aria-live");
  expect(screen.queryByRole("dialog", { name: title })).not.toBeInTheDocument();
  expect(testStorage.key(0)).toContain(":01JD0000000000000000000001:update:");

  const queryCount = first.calls.filter(({ path }) => path === "compliance.policies.myStatus").length;
  versions = [second, informationalPolicy];
  await act(async () => first.location.navigate("/orders/synthetic/files"));
  await waitFor(() => expect(first.calls.filter(({ path }) => path === "compliance.policies.myStatus").length).toBeGreaterThan(queryCount));
  expect(screen.queryByRole("dialog", { name: title })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Policy review reminder" })).toBe(banner);
  await userEvent.click(within(banner).getByRole("button", { name: "Review policies" }));
  expect(await screen.findByRole("dialog", { name: title })).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(await screen.findByRole("button", { name: "Review policies" })).toHaveFocus();
  first.unmount();

  const secondView = informational(() => versions);
  expect(await screen.findByRole("region", { name: "Policy review reminder" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: title })).not.toBeInTheDocument();
  versions = [second, { ...informationalPolicy, versionPublicId: "01JD0000000000000000000412", versionLabel: "3.0" }];
  await act(async () => secondView.location.navigate("/orders/synthetic/overview"));
  expect(await screen.findByRole("dialog", { name: title })).toHaveTextContent("Version 2 · 3.0");
});

it("remembers an Escape dismissal in memory when storage writes are blocked", async () => {
  const version = { ...informationalPolicy, versionPublicId: "01JD0000000000000000000413" };
  const write = Storage.prototype.setItem;
  const mocked = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (this === testStorage && key.startsWith("rp:policy-snooze:")) throw new DOMException("Storage disabled");
    write.call(this, key, value);
  });
  try {
    const first = informational(() => [version]);
    await screen.findByRole("dialog", { name: "Updated policies need your review" });
    await userEvent.keyboard("{Escape}");
    await screen.findByRole("region", { name: "Policy review reminder" });
    expect(testStorage.length).toBe(0);
    first.unmount();
    informational(() => [version]);
    expect(await screen.findByRole("region", { name: "Policy review reminder" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  } finally {
    mocked.mockRestore();
  }
});

it("keeps a grace countdown visible on navigation and alerts once per crossed checkpoint", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const policy = { ...item, deadline: new Date(now + 90 * 60_000) };
  try {
    const view = grace(policy);
    const title = "An updated policy needs your attention";
    await userEvent.click(within(await screen.findByRole("dialog", { name: title })).getByRole("button", { name: "Later" }));
    const banner = await screen.findByRole("region", { name: "Policy review reminder" });
    expect(banner).toHaveTextContent("Time remaining:");
    expect(banner.querySelector("time")).toHaveAttribute("datetime", policy.deadline.toISOString());
    const queryCount = view.calls.filter(({ path }) => path === "compliance.policies.enforcement.pending").length;
    await act(async () => view.location.navigate("/orders/synthetic/files"));
    await waitFor(() => expect(view.calls.filter(({ path }) => path === "compliance.policies.enforcement.pending").length).toBeGreaterThan(queryCount));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Policy review reminder" })).toBe(banner);
    clock.mockReturnValue(now + 30 * 60_000 + 1);
    fireEvent(document, new Event("visibilitychange"));
    await userEvent.click(within(await screen.findByRole("dialog", { name: title })).getByRole("button", { name: "Later" }));
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    clock.mockReturnValue(now + 76 * 60_000);
    fireEvent(document, new Event("visibilitychange"));
    await userEvent.click(within(await screen.findByRole("dialog", { name: title })).getByRole("button", { name: "Later" }));
    clock.mockReturnValue(now + 89 * 60_000 + 1);
    fireEvent(document, new Event("visibilitychange"));
    expect(await screen.findByRole("dialog", { name: title })).toBeInTheDocument();
  } finally {
    clock.mockRestore();
  }
});

it("requires review and consent, focuses the missing signature, then submits the exact version and hash", async () => {
  const { calls } = remediation();
  const form = await screen.findByRole("form", { name: item.title });
  const region = within(form).getByRole("region");
  const checkbox = within(form).getByRole("checkbox");
  const signature = within(form).getByRole("textbox", { name: /Type your full name to sign/ });
  const submit = within(form).getByRole("button", { name: "Accept this version" });
  Object.defineProperties(region, { scrollHeight: { value: 500 }, clientHeight: { value: 100 } });
  region.scrollTop = 400;
  fireEvent.scroll(region);
  expect(submit).toBeDisabled();
  checkbox.focus();
  await userEvent.keyboard(" ");
  submit.focus();
  await userEvent.keyboard("{Enter}");
  expect(signature).toHaveFocus();
  expect(within(form).getByRole("alert")).toHaveTextContent("Type the full name on your account.");
  expect(calls.some(({ path }) => path === "compliance.policies.enforcement.accept")).toBe(false);
  await userEvent.type(signature, "Avery Example");
  await userEvent.click(submit);
  await waitFor(() => expect(calls.find(({ path }) => path === "compliance.policies.enforcement.accept")?.input).toEqual({
    versionPublicId: item.versionPublicId, contentHash: item.contentHash, signerName: "Avery Example",
  }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Pending required policies" })).toHaveFocus());
});

it("associates a server name mismatch with the signer field and announces it", async () => {
  remediation(true);
  const form = await screen.findByRole("form", { name: item.title });
  const signature = within(form).getByRole("textbox", { name: /Type your full name to sign/ });
  await waitFor(() => expect(signature).toHaveAccessibleDescription("Use the name on your account: Avery Example."));
  await userEvent.click(within(form).getByRole("checkbox"));
  await userEvent.type(signature, "Wrong name");
  await userEvent.click(within(form).getByRole("button", { name: "Accept this version" }));
  const error = "The typed signature must match your account profile name.";
  expect(await within(form).findByRole("alert")).toHaveTextContent(error);
  expect(signature).toHaveFocus();
  expect(signature).toHaveAttribute("aria-invalid", "true");
  expect(signature).toHaveAccessibleDescription(`Use the name on your account: Avery Updated Name. ${error}`);
});

it.each([[1, "1 person who has"], [2, "2 people who have"]])("describes %i unaccepted recipients correctly", async (count, wording) => {
  renderWithTrpc(<Host><PolicyNoticeCard documentPublicId="01JD0000000000000000000401" /></Host>, {
    "compliance.policies.notices.status": () => ({
      delayHours: 24, notice: {
        publicId: "01JD0000000000000000000411", scheduledAt: item.deadline, state: "scheduled",
        revision: 1, pending: count, queued: 0, sent: 0, failed: 0, accepted: 0,
      },
    }),
  });
  await userEvent.click(await screen.findByRole("button", { name: "Send notice to everyone now" }));
  expect(await screen.findByRole("alertdialog", { name: "Send this policy notice now?" }))
    .toHaveAccessibleDescription(`This will email ${wording} not accepted this version and notify them in the portal.`);
});

it("binds cancellation to the revision reviewed, even if the card refreshes to a newer notice", async () => {
  const publicId = "01JD0000000000000000000411";
  const scheduled = {
    delayHours: 24,
    notice: { publicId, scheduledAt: item.deadline, state: "scheduled", revision: 1, pending: 2, queued: 0, sent: 0, failed: 0, accepted: 0 },
  };
  const { calls, queryClient } = renderWithTrpc(<Host><PolicyNoticeCard documentPublicId="01JD0000000000000000000401" /></Host>, {
    "compliance.policies.notices.status": () => scheduled,
    "compliance.policies.notices.cancel": () => ({ revision: 2, state: "cancelled" }),
  });
  await userEvent.click(await screen.findByRole("button", { name: "Cancel notice" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Cancel this policy notice?" });
  const statusQuery = queryClient.getQueryCache().getAll().find(({ queryKey }) =>
    JSON.stringify(queryKey).includes('["compliance","policies","notices","status"]'));
  expect(statusQuery).toBeDefined();
  act(() => {
    queryClient.setQueryData(statusQuery!.queryKey, {
      ...scheduled, notice: { ...scheduled.notice, publicId: "01JD0000000000000000000412", revision: 2, queued: 17 },
    });
  });
  await screen.findByText("17");
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel notice" }));
  await waitFor(() => expect(calls.find(({ path }) => path === "compliance.policies.notices.cancel")?.input).toEqual({
    noticePublicId: publicId, revision: 1,
  }));
});

it("checks enforcement on demand before a named coverage-row action and requires explicit confirmation", async () => {
  const userPublicId = "01JD0000000000000000000301";
  const { calls } = renderWithTrpc(<Host><EndPolicySessionsAction
    userPublicId={userPublicId} versionPublicId={item.versionPublicId} customerName="Avery Example" checkOnDemand
  /></Host>, {
    "compliance.policies.enforcement.forTarget": () => ({ canEndSessions: true }),
    "compliance.policies.enforcement.endNow": () => ({ ended: 2 }),
  });
  const trigger = await screen.findByRole("button", { name: "End sessions now for Avery Example" });
  expect(calls).toHaveLength(0);
  await userEvent.click(trigger);
  const dialogue = await screen.findByRole("alertdialog", { name: "End all sessions for this user?" });
  expect(calls.map(({ path }) => path)).toEqual(["compliance.policies.enforcement.forTarget"]);
  await userEvent.click(within(dialogue).getByRole("button", { name: "End sessions now" }));
  await screen.findByText("Ended 2 sessions.");
  expect(calls[1]?.input).toEqual({ userPublicId, versionPublicId: item.versionPublicId });
});

pageA11y("policy remediation exact-version form", async () => {
  remediation();
  await screen.findByRole("form", { name: item.title });
});
