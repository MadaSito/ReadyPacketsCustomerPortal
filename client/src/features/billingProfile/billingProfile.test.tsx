import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingProfileView } from "@server/modules/billingProfile";
import type * as transport from "@/lib/trpc";
import { pageA11y } from "@/test/a11y";
import { expectNoAxeViolations, renderUi } from "@/ui/testing";
import {
  BillingFields,
  EMPTY_BILLING_DETAILS,
  extractBillingFieldErrors,
  formatBillingSummaryLines,
  isBillingFieldsEmpty,
  validateBillingFields,
} from "./BillingFields";
import BillingInformationPage from "./BillingInformationPage";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("@/lib/trpc", async (original) => ({
  ...(await original<typeof transport>()),
  useTRPC: () => ({
    billingProfile: {
      get: {
        queryKey: () => ["billingProfile.get"],
        queryOptions: () => ({
          queryKey: ["billingProfile.get"],
          queryFn: () => mocks.get(),
        }),
      },
      save: {
        mutationOptions: () => ({
          mutationFn: (input: unknown) => mocks.save(input),
        }),
      },
      clear: {
        mutationOptions: () => ({
          mutationFn: (input: unknown) => mocks.clear(input),
        }),
      },
    },
  }),
}));

const SAVED_FIXTURE: BillingProfileView = {
  publicId: "01JD8000000000000000000101",
  details: {
    fullName: "Zeus Greene",
    company: "Ice Queen Studio LLC",
    email: "zeus.greene@example.test",
    country: "US",
    region: "NY",
    addressLine1: "742 Frostway Avenue",
    addressLine2: "Suite 400",
    city: "Syracuse",
    postalCode: "13202",
    taxId: "US-SYNTH-998877",
  },
  version: 2,
  updatedAt: new Date("2026-11-26T10:00:00.000Z"),
};

beforeEach(() => {
  mocks.get.mockReset();
  mocks.save.mockReset();
  mocks.clear.mockReset();
  mocks.get.mockResolvedValue(null);
});

const renderBillingPage = () =>
  renderUi(
    <main>
      <title>Billing information · ReadyPackets</title>
      <BillingInformationPage />
    </main>,
    { path: "/account/billing" },
  );

pageA11y("/account/billing empty state", async () => {
  mocks.get.mockResolvedValue(null);
  renderBillingPage();
  await screen.findByTestId("billing-profile-empty");
});

pageA11y("/account/billing saved state", async () => {
  mocks.get.mockResolvedValue(SAVED_FIXTURE);
  renderBillingPage();
  await screen.findByTestId("billing-profile-summary");
});

pageA11y("/account/billing clear confirmation dialog", async () => {
  mocks.get.mockResolvedValue(SAVED_FIXTURE);
  renderBillingPage();
  await screen.findByTestId("billing-profile-summary");
  await userEvent.click(screen.getByRole("button", { name: "Clear billing information" }));
  await screen.findByRole("alertdialog", { name: "Clear saved billing information?" });
});

describe("BillingFields helpers & autocomplete contract", () => {
  it("exposes WCAG 1.3.5 billing autocomplete tokens and wires field errors cleanly", () => {
    const onChange = vi.fn();
    renderUi(
      <BillingFields
        idPrefix="checkout-billing"
        value={EMPTY_BILLING_DETAILS}
        onChange={onChange}
        errors={{ fullName: "Enter the billing contact name.", country: "Enter a two-letter country code, such as US, CA or GB." }}
      />,
    );

    expect(screen.getByLabelText(/Billing name/)).toHaveAttribute("autocomplete", "billing name");
    expect(screen.getByLabelText(/Billing name/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/Billing email/)).toHaveAttribute("autocomplete", "billing email");
    expect(screen.getByLabelText(/Company/)).toHaveAttribute("autocomplete", "billing organization");
    expect(screen.getByLabelText(/Address line 1/)).toHaveAttribute("autocomplete", "billing address-line1");
    expect(screen.getByLabelText(/Address line 2/)).toHaveAttribute("autocomplete", "billing address-line2");
    expect(screen.getByLabelText(/City or locality/)).toHaveAttribute("autocomplete", "billing address-level2");
    expect(screen.getByLabelText(/State, province or region/)).toHaveAttribute("autocomplete", "billing address-level1");
    expect(screen.getByLabelText(/Postal code/)).toHaveAttribute("autocomplete", "billing postal-code");
    expect(screen.getByLabelText(/Country code/)).toHaveAttribute("autocomplete", "billing country");
  });

  it("detects empty optional forms, validates partial inputs, maps server fieldErrors, and formats summaries", () => {
    expect(isBillingFieldsEmpty(EMPTY_BILLING_DETAILS)).toBe(true);
    expect(isBillingFieldsEmpty({ ...EMPTY_BILLING_DETAILS, fullName: "   " })).toBe(true);
    expect(isBillingFieldsEmpty({ ...EMPTY_BILLING_DETAILS, fullName: "Zeus" })).toBe(false);

    const invalid = validateBillingFields({ ...EMPTY_BILLING_DETAILS, country: "usa" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.firstKey).toBe("fullName");
      expect(invalid.errors.country).toMatch(/two-letter country code/i);
    }

    const valid = validateBillingFields({ ...SAVED_FIXTURE.details, country: "us" });
    expect(valid).toEqual({ ok: true, data: SAVED_FIXTURE.details });

    expect(
      extractBillingFieldErrors({ "details.country": ["Select a two-letter country code."] }, "details"),
    ).toEqual({ country: "Select a two-letter country code." });

    expect(formatBillingSummaryLines(SAVED_FIXTURE.details)).toEqual([
      "Zeus Greene · Ice Queen Studio LLC",
      "zeus.greene@example.test",
      "742 Frostway Avenue, Suite 400",
      "Syracuse, NY, 13202, US",
      "Tax ID: US-SYNTH-998877",
    ]);
  });
});

describe("BillingInformationPage (/account/billing)", () => {
  it("validates required inputs with focus management, saves new details, updates with expectedVersion + expectedPublicId, and clears after confirmation", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue(null);
    mocks.save.mockImplementation(
      async (input: {
        details: BillingProfileView["details"];
        expectedVersion: number;
        expectedPublicId?: string;
      }) => ({
        publicId: input.expectedPublicId ?? "01JD8000000000000000000501",
        details: input.details,
        version: input.expectedVersion + 1,
        updatedAt: new Date("2026-11-26T11:00:00.000Z"),
      }),
    );
    mocks.clear.mockResolvedValue({ cleared: true });

    renderBillingPage();

    const page = await screen.findByTestId("billing-profile-page");
    expect(page).toHaveAttribute("data-profile-state", "empty");
    expect(screen.getByTestId("billing-profile-empty")).toBeInTheDocument();

    // Submitting blank focuses the first required field and announces errors.
    await user.click(screen.getByRole("button", { name: "Save billing information" }));
    const nameInput = screen.getByLabelText(/Billing name/);
    await waitFor(() => expect(nameInput).toHaveFocus());
    expect(nameInput).toHaveAttribute("aria-invalid", "true");

    await user.type(nameInput, "Zeus Greene");
    await user.type(screen.getByLabelText(/Billing email/), "zeus.greene@example.test");
    await user.type(screen.getByLabelText(/Company/), "Ice Queen Studio LLC");
    await user.type(screen.getByLabelText(/Address line 1/), "742 Frostway Avenue");
    await user.type(screen.getByLabelText(/City or locality/), "Syracuse");
    await user.type(screen.getByLabelText(/State, province or region/), "NY");
    await user.type(screen.getByLabelText(/Postal code/), "13202");
    await user.type(screen.getByLabelText(/Country code/), "us");

    await user.click(screen.getByRole("button", { name: "Save billing information" }));

    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        expectedVersion: 0,
        details: expect.objectContaining({
          fullName: "Zeus Greene",
          company: "Ice Queen Studio LLC",
          email: "zeus.greene@example.test",
          addressLine1: "742 Frostway Avenue",
          city: "Syracuse",
          region: "NY",
          postalCode: "13202",
          country: "US",
        }),
      }),
    );

    expect(await screen.findByTestId("billing-profile-summary")).toHaveTextContent(
      "Zeus Greene · Ice Queen Studio LLC",
    );
    expect(page).toHaveAttribute("data-profile-state", "saved");

    // Second save sends expectedVersion: 1 + expectedPublicId.
    const cityInput = screen.getByLabelText(/City or locality/);
    await user.clear(cityInput);
    await user.type(cityInput, "Albany");
    await user.click(screen.getByRole("button", { name: "Save billing information" }));

    await waitFor(() =>
      expect(mocks.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          expectedVersion: 1,
          expectedPublicId: "01JD8000000000000000000501",
          details: expect.objectContaining({ city: "Albany" }),
        }),
      ),
    );

    // Clear with confirmation sends expectedVersion: 2 + expectedPublicId and returns to empty state.
    await user.click(screen.getByRole("button", { name: "Clear billing information" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Clear saved billing information?" });
    await user.click(within(dialog).getByRole("button", { name: "Clear billing information" }));

    await waitFor(() =>
      expect(mocks.clear).toHaveBeenCalledWith({
        expectedVersion: 2,
        expectedPublicId: "01JD8000000000000000000501",
      }),
    );
    expect(await screen.findByTestId("billing-profile-empty")).toBeInTheDocument();
    expect(page).toHaveAttribute("data-profile-state", "empty");
    await expectNoAxeViolations();
  });

  it("handles BILLING_PROFILE_VERSION_CONFLICT by offering one-click reload of latest saved details", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValueOnce(SAVED_FIXTURE).mockResolvedValueOnce({
      ...SAVED_FIXTURE,
      version: 3,
      details: { ...SAVED_FIXTURE.details, city: "Buffalo" },
    });
    mocks.save.mockRejectedValueOnce({
      data: {
        safe: {
          domainCode: "CONFLICT",
          reasonCode: "BILLING_PROFILE_VERSION_CONFLICT",
          safeMessage: "Your billing information was updated in another tab or session. Reload and try again.",
          requestId: "req-1",
        },
      },
    });

    renderBillingPage();
    await screen.findByTestId("billing-profile-summary");

    const cityInput = screen.getByLabelText(/City or locality/);
    await user.clear(cityInput);
    await user.type(cityInput, "Ithaca");
    await user.click(screen.getByRole("button", { name: "Save billing information" }));

    expect(
      await screen.findByText("Your billing information was updated in another tab or session. Reload and try again."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reload latest saved details" }));
    await waitFor(() => expect(screen.getByLabelText(/City or locality/)).toHaveValue("Buffalo"));
  });
});
