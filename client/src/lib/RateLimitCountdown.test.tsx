import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RateLimitCountdown, retryDelaySeconds } from "./RateLimitCountdown";

function error(status: string, delay: string) {
  return { data: { safe: { domainCode: status } }, meta: { response: new Response(null, { headers: { "Retry-After": delay } }) } };
}

it("only uses a bounded numeric Retry-After for a generic rate-limit response", () => {
  expect(retryDelaySeconds(error("RATE_LIMITED", "120"))).toBe(120);
  expect(retryDelaySeconds(error("RATE_LIMITED", "Wed, 01 Jan 2031 00:00:00 GMT"))).toBeNull();
  expect(retryDelaySeconds(error("RATE_LIMITED", "700000"))).toBeNull();
  expect(retryDelaySeconds(error("FORBIDDEN", "10"))).toBeNull();
});

it("counts down and announces only the starting and ending state", () => {
  vi.useFakeTimers();
  try {
    render(<RateLimitCountdown error={error("RATE_LIMITED", "2")} />);
    expect(screen.getByText("Try again in 2 sec.")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Wait before trying again.");
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("Try again in 1 sec.")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Wait before trying again.");
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole("status")).toHaveTextContent("You can try again now.");
  } finally {
    vi.useRealTimers();
  }
});
