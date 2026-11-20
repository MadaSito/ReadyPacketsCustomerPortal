import { defineConfig } from "drizzle-kit";

/** Migration generation only. Never reads production credentials from the repository. */
export default defineConfig({
  dialect: "mysql",
  schema: "./server/db/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "mysql://invalid.invalid/none" },
  strict: true,
  verbose: true,
});
