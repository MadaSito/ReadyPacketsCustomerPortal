/**
 * Test helpers for component tests (jsdom). Import from "@/ui/testing" in *.test.tsx only.
 *   renderUi(<Page/>, { api, path })  — wraps Theme, Toast, QueryClient, AuthApi (fake), StepUp and a memory router.
 *   await expectNoAxeViolations(container)
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import axe from "axe-core";
import type { ReactElement, ReactNode } from "react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AuthApiProvider, type AuthApi } from "@/lib/authApi";
import { StepUpProvider } from "./StepUp";
import { ThemeProvider } from "./theme";
import { ToastProvider } from "./Toast";

export function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
}

/** A fake AuthApi whose methods reject unless overridden. */
export function fakeAuthApi(overrides: Partial<AuthApi> = {}): AuthApi {
  const missing = (name: string) => () => Promise.reject(new Error(`fakeAuthApi.${name} not stubbed`));
  const base = new Proxy({} as AuthApi, { get: (_t, prop: string) => missing(prop) });
  return Object.assign(Object.create(base) as AuthApi, overrides);
}

export interface RenderUiOptions {
  api?: AuthApi;
  path?: string;
  queryClient?: QueryClient;
  wrapper?: (children: ReactNode) => ReactNode;
}

export function renderUi(ui: ReactElement, options: RenderUiOptions = {}): RenderResult & { location: ReturnType<typeof memoryLocation>; queryClient: QueryClient } {
  const location = memoryLocation({ path: options.path ?? "/", record: true });
  const queryClient = options.queryClient ?? createTestQueryClient();
  const tree = (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthApiProvider api={options.api ?? fakeAuthApi()}>
          <ToastProvider>
            <StepUpProvider>
              <Router hook={location.hook}>{options.wrapper ? options.wrapper(ui) : ui}</Router>
            </StepUpProvider>
          </ToastProvider>
        </AuthApiProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
  return Object.assign(render(tree), { location, queryClient });
}

/** Runs axe-core (WCAG 2.x A/AA + 2.2 rules) on the given node; color-contrast is covered by tokens.test.ts (jsdom has no layout). */
export async function expectNoAxeViolations(node: Element = document.body): Promise<void> {
  const result = await axe.run(node, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  const violations = result.violations.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  if (violations.length) throw new Error(`axe violations:\n${violations.join("\n")}`);
}
