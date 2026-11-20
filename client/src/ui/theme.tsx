/**
 * System / Light / Dark theme. Preference is held in memory only (no browser storage, by contract);
 * "system" follows prefers-color-scheme live. Applies `dark` class + color-scheme on <html>.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const QUERY = "(prefers-color-scheme: dark)";

function systemTheme(): ResolvedTheme {
  return typeof window !== "undefined" && window.matchMedia?.(QUERY).matches ? "dark" : "light";
}

export function ThemeProvider({ children, initial = "system" }: { children: ReactNode; initial?: ThemePreference }) {
  const [preference, setPreference] = useState<ThemePreference>(initial);
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);

  useEffect(() => {
    const mql = window.matchMedia?.(QUERY);
    if (!mql) return;
    const onChange = () => setSystem(mql.matches ? "dark" : "light");
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, []);

  const resolved: ResolvedTheme = preference === "system" ? system : preference;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    root.style.colorScheme = resolved;
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#071824" : "#0D1B2A");
  }, [resolved]);

  const set = useCallback((next: ThemePreference) => setPreference(next), []);
  const value = useMemo(() => ({ preference, resolved, setPreference: set }), [preference, resolved, set]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) return { preference: "system", resolved: systemTheme(), setPreference: () => {} };
  return ctx;
}
