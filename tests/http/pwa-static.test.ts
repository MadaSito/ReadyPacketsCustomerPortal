import { vi, expect, it } from "vitest";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";

const { sendStatic, createStatic } = vi.hoisted(() => {
  const sendStatic = vi.fn();
  return { sendStatic, createStatic: vi.fn(() => sendStatic) };
});
vi.mock("express", () => ({ default: { static: createStatic } }));
vi.mock("../../server/http/edge", () => ({ isNavigation: vi.fn() }));
import { registerStatic } from "../../server/http/static";

it("allows only the exact public offline document through raw static HTML", () => {
  const use = vi.fn();
  registerStatic({ use } as unknown as Express, "/fixture/public", new Set());
  const middleware = use.mock.calls[0]?.[0] as RequestHandler;
  const res = {} as Response;
  const next: NextFunction = vi.fn();

  middleware({ path: "/offline.html" } as Request, res, next);
  expect(sendStatic).toHaveBeenCalledTimes(1);
  for (const path of ["/index.html", "/other.html", "/brand/other.html", "/%6fffline.html", "/OFFLINE.html"]) {
    middleware({ path } as Request, res, next);
  }
  expect(sendStatic).toHaveBeenCalledTimes(1);
  expect(next).toHaveBeenCalledTimes(5);
});

it("publishes the worker scope without overriding private no-store or enabling long freshness", () => {
  registerStatic({ use: vi.fn() } as unknown as Express, "/fixture/public", new Set());
  const calls = createStatic.mock.calls as unknown as [string, { setHeaders(res: Response, file: string): void }][];
  const options = calls.at(-1)![1];
  const headers = new Map<string, string>();
  const res = { setHeader: (name: string, value: string) => headers.set(name, value),
    getHeader: (name: string) => headers.get(name) } as unknown as Response;
  options.setHeaders(res, "/fixture/public/sw.js");
  expect(headers.get("Service-Worker-Allowed")).toBe("/");
  expect(headers.get("Cache-Control")).toBe("no-cache");
  headers.set("Cache-Control", "no-store");
  options.setHeaders(res, "/fixture/public/manifest.webmanifest");
  expect(headers.get("Cache-Control")).toBe("no-store");
});
