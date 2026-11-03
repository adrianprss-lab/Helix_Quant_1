import type { Config } from "drizzle-kit";

/**
 * Reads DATABASE_URL from the environment (drizzle-kit loads .env by default),
 * so the same config works in the sandbox, in Docker and on any VPS.
 */
export default {
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/app_db",
  },
} satisfies Config;
