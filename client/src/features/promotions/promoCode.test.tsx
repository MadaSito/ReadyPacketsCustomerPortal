import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageA11y } from "@/test/a11y";
import { renderUi } from "@/ui/testing";
import { PROMO_UNIFORM_ERROR, PromoCodeField, type AppliedPromo } from "./PromoCodeField";
import PromoLandingPage from "./PromoLandingPage";
import { capturePromoCodeFromFragment, capturePromoLinkAtStartup, clearSavedPromoCode, isPlausiblePromoCode, maskPromoCode, normalizePromoCode, promoLink, readSavedPromoCode, savePromoCode, takeStartupInvalidCapture } from "./savedCode";

const session = vi.hoisted(() => ({ status: "anonymous" as string }));
vi.mock("@/lib/session", () => ({ useSession: () => ({ view: { status: session.status }, me: undefined }) }));

const trpcError = (reasonCode: string, safeMessage = "Refused") => Object.assign(new Error(reasonCode), { data: { safe: { domainCode: "VALIDATION", reasonCode, safeMessage, requestId: "r" } } });

beforeEach(() => {
  clearSavedPromoCode();
  session.status = "anonymous";
  window.history.replaceState(null, "", "/");
});
afterEach(() => vi.restoreAllMocks());

describe("capturePromoLinkAtStartup (entry bootstrap, before routing)", () => {
  const fakeHistory = () => ({ state: null, replaceState: vi.fn() });
  it("on exactly /promo saves the code and strips the fragment before anything else runs", () => {
    const hist = fakeHistory();
    expect(capturePromoLinkAtStartup({ pathname: "/promo", search: "", hash: "#promo=spring-2026" }, hist)).toEqual({ kind: "saved", code: "SPRING-2026" });
    expect(hist.replaceState).toHaveBeenCalledWith(null, "", "/promo");
    expect(readSavedPromoCode()).toBe("SPRING-2026");
  });
  it("leaves every other path and fragment alone", () => {
    const hist = fakeHistory();
    expect(capturePromoLinkAtStartup({ pathname: "/cart", search: "", hash: "#promo=SPRING-2026" }, hist)).toEqual({ kind: "none" });
    expect(capturePromoLinkAtStartup({ pathname: "/promo/x", search: "", hash: "#promo=SPRING-2026" }, hist)).toEqual({ kind: "none" });
    expect(hist.replaceState).not.toHaveBeenCalled();
    expect(readSavedPromoCode()).toBeNull();
  });
  it("an invalid code is still stripped and reported once to the landing page", () => {
    const hist = fakeHistory();
    expect(capturePromoLinkAtStartup({ pathname: "/promo", search: "", hash: "#promo=%3Cx%3E" }, hist).kind).toBe("invalid");
    expect(hist.replaceState).toHaveBeenCalled();
    expect(takeStartupInvalidCapture()).toBe(true);
    expect(takeStartupInvalidCapture()).toBe(false);
  });
  it("plausibility matches the contract: 6–32 of A–Z 0–9 hyphen", () => {
    expect(isPlausiblePromoCode("ABCDE")).toBe(false);
    expect(isPlausiblePromoCode("ABCDEF")).toBe(true);
    expect(isPlausiblePromoCode("A".repeat(32))).toBe(true);
    expect(isPlausiblePromoCode("A".repeat(33))).toBe(false);
    expect(isPlausiblePromoCode("AB_CDEF")).toBe(false);
  });
});

describe("saved promotion code (link landing storage)", () => {
  it("captures #promo= into sessionStorage, strips the whole fragment and never sets a cookie", () => {
    window.history.replaceState(null, "", "/promo?x=1#promo=spring-2026");
    const cookie = document.cookie;
    expect(capturePromoCodeFromFragment()).toEqual({ kind: "saved", code: "SPRING-2026" });
    expect(window.location.hash).toBe("");
    expect(window.location.pathname + window.location.search).toBe("/promo?x=1");
    expect(readSavedPromoCode()).toBe("SPRING-2026");
    expect(document.cookie).toBe(cookie);
  });

  it("rejects implausible codes but still strips the fragment", () => {
    window.history.replaceState(null, "", "/promo#promo=%3Cscript%3E");
    expect(capturePromoCodeFromFragment()).toEqual({ kind: "invalid" });
    expect(window.location.hash).toBe("");
    expect(readSavedPromoCode()).toBeNull();
    expect(savePromoCode("ab")).toBe(false);
  });

  it("builds fragment links, normalises and masks", () => {
    expect(promoLink("https://portal.example.test/", " spring-2026 ")).toBe("https://portal.example.test/promo#promo=SPRING-2026");
    expect(promoLink("https://portal.example.test", "x").includes("?")).toBe(false);
    expect(normalizePromoCode(" ab cd-12 ")).toBe("ABCD-12");
    expect(maskPromoCode("SPRING-2026")).toBe("SP•••••••26");
  });
});

/* A host like the cart: applies through its own server call. */
function Host({ onApply }: { onApply: (code: string) => Promise<void> }) {
  const [applied, setApplied] = useState<AppliedPromo | null>(null);
  return (
    <PromoCodeField
      applied={applied}
      onApply={async (code) => {
        await onApply(code);
        setApplied({ label: "Spring offer", discountMinor: 2500, currency: "USD" });
      }}
      onRemove={async () => setApplied(null)}
    />
  );
}
/** The field's own polite region (the ToastProvider adds other status regions). */
const live = () => document.querySelector("p[role='status'][aria-live='polite']")!;
/** The visible error text (the same text is also announced). */
const errorText = (text: string) => screen.findByText(text, { selector: "[id$='-error'] span" });
const page = (ui: React.ReactElement, title = "Cart") => {
  document.title = title;
  return renderUi(<main id="main"><h1>{title}</h1>{ui}</main>);
};

describe("PromoCodeField", () => {
  it("applies a normalised code, shows label and amount, announces, and moves focus to Remove; Remove returns focus", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn(async () => undefined);
    page(<Host onApply={onApply} />);
    await user.type(screen.getByLabelText("Discount code"), " spring-2026 ");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith("SPRING-2026");
    expect(await screen.findByText(/Spring offer/u)).toBeTruthy();
    expect(screen.getByText(/\$25\.00/u)).toBeTruthy();
    expect(live().textContent).toBe("Discount code applied.");
    const remove = screen.getByRole("button", { name: "Remove discount Spring offer" });
    await waitFor(() => expect(document.activeElement).toBe(remove));
    await user.click(remove);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Discount code")));
    expect(live().textContent).toBe("Discount code removed.");
  });

  it.each(["PROMO_NOT_APPLICABLE", "PROMO_EXPIRED", "SOMETHING_ELSE"])("shows only the uniform message for %s, linked to the input", async (reason) => {
    const user = userEvent.setup();
    page(<Host onApply={async () => { throw trpcError(reason, "Leaky detail about the code"); }} />);
    await user.type(screen.getByLabelText("Discount code"), "UNKNOWN-1");
    await user.keyboard("{Enter}");
    const message = await errorText(PROMO_UNIFORM_ERROR);
    const input = screen.getByLabelText("Discount code");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain(message.parentElement!.id);
    expect(document.body.textContent).not.toContain("Leaky detail");
    expect(document.activeElement).toBe(input);
  });

  it("shows the server message for cart-specific reasons", async () => {
    const user = userEvent.setup();
    page(<Host onApply={async () => { throw trpcError("PROMO_MIN_SUBTOTAL", "Add $20.00 more to use this code."); }} />);
    await user.type(screen.getByLabelText("Discount code"), "SPRING-2026");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await errorText("Add $20.00 more to use this code.")).toBeTruthy();
  });

  it("offers a code saved from a link without applying it, then clears it once applied", async () => {
    const user = userEvent.setup();
    savePromoCode("LINK-CODE-77");
    const onApply = vi.fn(async () => undefined);
    page(<Host onApply={onApply} />);
    expect(onApply).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Use saved code" }));
    expect(onApply).toHaveBeenCalledWith("LINK-CODE-77");
    await screen.findByText(/Spring offer/u);
    expect(readSavedPromoCode()).toBeNull();
  });

  it("uses the host live region when given and is masked from analytics", async () => {
    const user = userEvent.setup();
    const onAnnounce = vi.fn();
    const { container } = page(<PromoCodeField applied={null} onApply={async () => { throw trpcError("PROMO_NOT_APPLICABLE"); }} onRemove={async () => undefined} onAnnounce={onAnnounce} />);
    await user.type(screen.getByLabelText("Discount code"), "UNKNOWN-1");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(onAnnounce).toHaveBeenCalledWith(PROMO_UNIFORM_ERROR));
    expect(document.querySelector("p[role='status'][aria-live='polite']")).toBeNull();
    const root = container.querySelector("[data-clarity-mask='true']");
    expect(root?.classList.contains("ph-no-capture")).toBe(true);
  });

  it("keyboard: Enter on the empty field asks for a code, announces it, links it, and calls nothing", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn(async () => undefined);
    page(<Host onApply={onApply} />);
    screen.getByLabelText("Discount code").focus();
    await user.keyboard("{Enter}");
    const message = await errorText("Enter a discount code.");
    expect(live().textContent).toBe("Enter a discount code.");
    expect(screen.getByLabelText("Discount code").getAttribute("aria-describedby")).toContain(message.parentElement!.id);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("the saved-code offer does not speak the code and does not steal focus after a slow apply", async () => {
    const user = userEvent.setup();
    savePromoCode("LINK-CODE-77");
    let release: () => void = () => undefined;
    page(<><Host onApply={() => new Promise<void>((r) => { release = r; })} /><button type="button">Elsewhere</button></>);
    expect(screen.getByRole("button", { name: "Use saved code" }).textContent).not.toContain("LINK");
    await user.click(screen.getByRole("button", { name: "Use saved code" }));
    screen.getByRole("button", { name: "Elsewhere" }).focus();
    await act(async () => release());
    await screen.findByText(/Spring offer/u);
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Elsewhere" }));
  });

  pageA11y("PromoCodeField empty with saved code", () => {
    savePromoCode("LINK-CODE-77");
    page(<Host onApply={async () => undefined} />);
  });
  pageA11y("PromoCodeField error state", async () => {
    const user = userEvent.setup();
    page(<Host onApply={async () => { throw trpcError("PROMO_NOT_APPLICABLE"); }} />);
    await user.type(screen.getByLabelText("Discount code"), "UNKNOWN-1");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await errorText(PROMO_UNIFORM_ERROR);
  });
  pageA11y("PromoCodeField applied state", async () => {
    const user = userEvent.setup();
    page(<Host onApply={async () => undefined} />);
    await user.type(screen.getByLabelText("Discount code"), "SPRING-2026");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText(/Spring offer/u);
  });
});

describe("promotion link landing page", () => {
  const landing = () => {
    document.title = "Discount code";
    return renderUi(<main id="main"><PromoLandingPage /></main>, { path: "/promo" });
  };

  it("saves the code, strips the fragment, says Code saved and offers sign-in / registration", () => {
    window.history.replaceState(null, "", "/promo#promo=SPRING-2026");
    landing();
    expect(screen.getByRole("heading", { level: 1, name: "Discount code" })).toBeTruthy();
    expect(screen.getByText("Code saved")).toBeTruthy();
    expect(window.location.hash).toBe("");
    expect(document.body.textContent).not.toContain("SPRING-2026");
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in");
    expect(screen.getByRole("link", { name: "Create an account" }).getAttribute("href")).toBe("/register");
  });

  it("keeps the code after the fragment is gone (e.g. after signing in) and links to cart and order wizard", () => {
    savePromoCode("SPRING-2026");
    session.status = "full";
    landing();
    expect(screen.getByText("Code saved")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to your cart" }).getAttribute("href")).toBe("/cart");
    expect(screen.getByRole("link", { name: "Start a new order" }).getAttribute("href")).toBe("/orders/new");
  });

  it("an invalid link says so; forgetting clears the saved code", async () => {
    window.history.replaceState(null, "", "/promo#promo=%3C%3E");
    landing();
    expect(screen.getByText("This link does not contain a usable code")).toBeTruthy();
    savePromoCode("SPRING-2026");
  });

  it("forget the saved code clears storage", async () => {
    const user = userEvent.setup();
    savePromoCode("SPRING-2026");
    landing();
    screen.getByRole("button", { name: "Forget the saved code" }).focus();
    await user.keyboard("{Enter}");
    expect(readSavedPromoCode()).toBeNull();
    expect(screen.getByText("No code saved")).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.textContent).toContain("No code saved"));
  });

  pageA11y("/promo saved", () => {
    window.history.replaceState(null, "", "/promo#promo=SPRING-2026");
    landing();
  });
  pageA11y("/promo signed in, invalid link", () => {
    session.status = "full";
    window.history.replaceState(null, "", "/promo#promo=%3C%3E");
    landing();
  });
});
