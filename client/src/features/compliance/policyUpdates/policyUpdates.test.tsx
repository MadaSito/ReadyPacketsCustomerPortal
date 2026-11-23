import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, type ReactNode } from "react";
import { expect, it } from "vitest";
import { pageA11y } from "@/test/a11y";
import { renderWithTrpc } from "../acceptance/testkit";
import { PolicyEnforcementPrompt, PolicyEnforcementRemediation } from "./PolicyEnforcementPrompt";

const item = {
  title: "Production agreement", versionLabel: "2.0", versionPublicId: "01JD0000000000000000000402",
  contentHash: "a".repeat(64), contentFormat: "plain_text", bodyText: "Exact synthetic policy text.",
  changeSummary: "The synthetic agreement was revised.", deadline: new Date(Date.now() + 60 * 60 * 1000),
  warningText: "Review {policy}. Time left: {timeLeft}.", requiresTypedSignature: true, blocking: false,
};

function Host({ children }: { children: ReactNode }) {
  useEffect(() => { document.title = "Policies | ReadyPackets"; }, []);
  return <main><h1>Policies</h1><button type="button">Portal control</button>{children}</main>;
}

function grace() {
  return renderWithTrpc(<Host><PolicyEnforcementPrompt /></Host>, {
    "compliance.policies.enforcement.pending": () => [item],
    "compliance.policies.myStatus": () => ({ pendingRequired: [] }),
  }, { role: "customer" });
}

function remediation() {
  let accepted = false;
  return renderWithTrpc(<Host><PolicyEnforcementRemediation /></Host>, {
    "compliance.policies.enforcement.pending": () => accepted ? [] : [{ ...item, blocking: true }],
    "compliance.policies.enforcement.accept": () => { accepted = true; return { accepted: true }; },
  }, { role: "customer" });
}

it("enters the grace dialog, moves keyboard focus into policy review, and dismisses by Escape", async () => {
  grace();
  const dialog = await screen.findByRole("dialog", { name: "An updated policy needs your attention" });
  const read = within(dialog).getByRole("button", { name: "Read and accept" });
  expect(dialog).toContainElement(document.activeElement);
  read.focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(screen.getByText("Policy text and acceptance")).toHaveFocus());
  expect(within(dialog).getByRole("region", { name: "Production agreement, version 2.0, full text" })).toHaveTextContent(item.bodyText);
  expect(within(dialog).getByRole("button", { name: "Accept this version" })).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
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

pageA11y("policy remediation exact-version form", async () => {
  remediation();
  await screen.findByRole("form", { name: item.title });
});
