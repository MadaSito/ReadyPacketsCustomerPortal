import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { clearRecoveryBatch, useRecoveryBatch } from "@/lib/recoveryBatch";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import type { StepUpApi } from "@/ui";
import { CredentialAdmin, type CredentialsActions } from "./pages/CredentialsTab";
import { SecuritySettings, type SecurityActions } from "./pages/SecurityPage";

const runDirectly: StepUpApi = { run: (action) => action(), request: async () => true };
const defaultState = {
  mfaEnrolled: true, recoveryCodesAcknowledged: true,
  recoveryCodesRemaining: 4, passkeyCount: 0, totpEnrolled: true,
};
const missing = () => Promise.reject(new Error("Unexpected synthetic action"));
afterEach(clearRecoveryBatch);

function security(overrides: Partial<SecurityActions> = {}, onExit = vi.fn()) {
  const actions: SecurityActions = {
    beginTotp: missing, confirmTotp: missing, disableTotp: missing, regenerate: missing, acknowledge: missing,
    beginPasskey: missing, finishPasskey: missing, renamePasskey: missing, removePasskey: missing, ...overrides,
  };
  return renderUi(<SecuritySettings state={defaultState} passkeys={[]} actions={actions} stepUp={runDirectly}
    refresh={vi.fn()} onUnacknowledgedExit={onExit} passkeysSupported={false} />, {
    path: "/account/security", wrapper: (children) => <main>{children}</main>,
  });
}

const target = "01JD0000000000000000000001";
const withCustomer = (children: ReactNode) => <main><h1>Customer record</h1>{children}</main>;
function HandoffProbe() {
  return <main><output>{useRecoveryBatch()?.recoverySetId ?? "No staged recovery batch"}</output></main>;
}

describe("account security settings", () => {
  it("exposes passkey availability and number of recovery codes without color alone", async () => {
    security();
    expect(screen.getByRole("heading", { name: "Account security", level: 1 })).toBeVisible();
    expect(screen.getByText("4 codes left")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add passkey" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove authenticator app" })).toBeDisabled();
    await expectNoAxeViolations();
  });

  it("requires explicit acknowledgment of the shown batch and removes the codes from the DOM afterward", async () => {
    const batch = { recoverySetId: "synthetic-batch", recoveryCodes: ["synthetic-code-1", "synthetic-code-2"] };
    const actions = {
      regenerate: vi.fn(async () => batch), acknowledge: vi.fn(async () => ({ ok: true })),
    };
    security(actions);
    fireEvent.click(screen.getByRole("button", { name: "Generate new recovery codes" }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Generate new codes" }));
    const codes = await screen.findByRole("dialog", { name: "Save your recovery codes" });
    expect(within(codes).getByText(/synthetic-code-1/)).toBeVisible();
    expect(actions.acknowledge).not.toHaveBeenCalled();
    await expectNoAxeViolations();
    fireEvent.click(within(codes).getByRole("button", { name: "I saved my recovery codes" }));
    await waitFor(() => expect(screen.queryByText(/synthetic-code-1/)).not.toBeInTheDocument());
    expect(actions.acknowledge).toHaveBeenCalledExactlyOnceWith(batch.recoverySetId);
    expect(screen.getByText("Recovery codes saved.")).toBeVisible();
    renderUi(<HandoffProbe />);
    expect(screen.getByText("No staged recovery batch")).toBeVisible();
  });

  it("keeps a batch available in memory after the settings page unmounts during remediation", async () => {
    const batch = { recoverySetId: "synthetic-handoff-batch", recoveryCodes: ["synthetic-handoff-code"] };
    const settings = security({ regenerate: async () => batch });
    fireEvent.click(screen.getByRole("button", { name: "Generate new recovery codes" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Generate new codes" }));
    await screen.findByText(batch.recoveryCodes[0]!);
    settings.unmount();
    renderUi(<HandoffProbe />);
    expect(screen.getByText(batch.recoverySetId)).toBeVisible();
  });

  it("drops an unacknowledged batch on close and hands off to the account transition guard", async () => {
    const onExit = vi.fn();
    const acknowledge = vi.fn(async () => ({ ok: true }));
    security({ regenerate: async () => ({ recoverySetId: "synthetic-batch", recoveryCodes: ["synthetic-code-3"] }), acknowledge }, onExit);
    fireEvent.click(screen.getByRole("button", { name: "Generate new recovery codes" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Generate new codes" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Close without saving" }));
    await waitFor(() => expect(screen.queryByText(/synthetic-code-3/)).not.toBeInTheDocument());
    expect(acknowledge).not.toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledTimes(1);
    renderUi(<HandoffProbe />);
    expect(screen.getByText("No staged recovery batch")).toBeVisible();
  });
});

describe("credentials administration widget", () => {
  it("disables email when the provider is unavailable, and reveals then discards the generated password", async () => {
    const temporaryPassword = "synthetic only generated value";
    const actions: CredentialsActions = {
      setCredential: vi.fn(async () => ({ ok: true as const, temporaryPassword })), resetMfa: missing,
    };
    renderUi(<CredentialAdmin customerId={target} actions={actions} stepUp={runDirectly} email={{ state: "unavailable" }} />, { wrapper: withCustomer });
    expect(screen.getByRole("option", { name: "Email a set-password link" })).toBeDisabled();
    expect(screen.getByText("Set-password email unavailable")).toBeVisible();
    await expectNoAxeViolations();
    fireEvent.click(screen.getByRole("button", { name: "Review password change" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Apply password change" }));
    const secret = await screen.findByRole("dialog", { name: "Temporary password generated" });
    expect(within(secret).getByText(temporaryPassword)).toBeVisible();
    expect(actions.setCredential).toHaveBeenCalledExactlyOnceWith({ mode: "generate_temporary", customerId: target });
    fireEvent.click(within(secret).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByText(temporaryPassword)).not.toBeInTheDocument());
    expect(screen.getByText("Temporary password set. The user’s sessions were revoked.")).toBeVisible();
  });

  it("validates administrator-entered passwords and submits only after confirmation", async () => {
    const actions: CredentialsActions = {
      setCredential: vi.fn(async () => ({ ok: true as const })), resetMfa: missing,
    };
    renderUi(<CredentialAdmin customerId={target} actions={actions} stepUp={runDirectly} email={{ state: "ready" }} />, { wrapper: withCustomer });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "enter_temporary" } });
    const input = screen.getByLabelText(/Temporary password/);
    fireEvent.change(input, { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Review password change" }));
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(actions.setCredential).not.toHaveBeenCalled();
    const password = "synthetic admin supplied value";
    fireEvent.change(input, { target: { value: password } });
    fireEvent.click(screen.getByRole("button", { name: "Review password change" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(actions.setCredential).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Apply password change" }));
    await waitFor(() => expect(actions.setCredential).toHaveBeenCalledExactlyOnceWith({
      mode: "enter_temporary", customerId: target, password,
    }));
    expect(input).toHaveValue("");
  });
});
