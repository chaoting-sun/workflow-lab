import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Tests need the same env vars as the app (zod-validated config). Load
// .env.example as defaults so `pnpm test` works on a fresh clone without a
// separate dotenv setup. Real env (CI, exported shell vars) wins.
const envFile = ".env.example";
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname) },
  },
  test: {
    // DB-touching tests share rows; schema.test.ts drops & recreates tables.
    // Serialise files so they don't clobber each other.
    fileParallelism: false,
  },
});
