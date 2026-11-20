import path from "node:path";
import { defineConfig } from "vitest/config";

const alias = {
  "@shared": path.resolve(import.meta.dirname, "shared"),
  "@server": path.resolve(import.meta.dirname, "server"),
  "@": path.resolve(import.meta.dirname, "client/src"),
};

/**
 * Two projects: `server` (node) covers server/, shared/, scripts/, portable/ and tests/;
 * `client` (jsdom) covers client/. Integration tests use real MySQL via tests/helpers/testDb.ts.
 */
export default defineConfig({
  resolve: { alias },
  test: {
    pool: "forks",
    maxWorkers: 2,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    projects: [
      {
        resolve: { alias },
        test: {
          name: "server",
          environment: "node",
          include: [
            "server/**/*.test.ts",
            "shared/**/*.test.ts",
            "scripts/**/*.test.ts",
            "portable/**/*.test.ts",
            "tests/**/*.test.ts",
          ],
        },
      },
      {
        resolve: { alias },
        esbuild: { jsx: "automatic" },
        test: {
          name: "client",
          environment: "jsdom",
          include: ["client/**/*.test.{ts,tsx}"],
          setupFiles: ["tests/helpers/clientSetup.ts"],
        },
      },
    ],
  },
});
