import { useEffect, useRef, type ReactNode } from "react";
import { useSearch } from "wouter";
import { holdReferralCodeFirstParty } from "./api";
import { REFERRAL_CODE_REGEX } from "./model";

/**
 * Non-visual route wrapper around `/register` that captures `/register?ref=CODE` into the
 * 30-day first-party `HttpOnly; SameSite=Lax` functional cookie (`/api/referrals/hold`)
 * without adding extra landmarks or touching browser Web Storage.
 */
export function RegisterReferralCapture({ children }: { children: ReactNode }) {
  const search = useSearch();
  const lastCapturedRef = useRef<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(search);
    const raw = params.get("ref")?.trim().toUpperCase() ?? "";
    if (!REFERRAL_CODE_REGEX.test(raw)) return;
    if (lastCapturedRef.current === raw) return;
    lastCapturedRef.current = raw;
    void holdReferralCodeFirstParty(raw);
  }, [search]);

  return <>{children}</>;
}
