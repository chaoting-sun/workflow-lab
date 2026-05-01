import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "./db";

let applied = false;

// db/schema.test.ts drops every table in its afterAll. Other DB-touching test
// files call this in beforeAll so they don't depend on test execution order.
export async function ensureSchema(): Promise<void> {
  if (applied) {
    const { rows } = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema='public' AND table_name='users'
       ) AS exists`,
    );
    if (rows[0].exists) return;
  }
  const candidates = [
    resolve(process.cwd(), "db/schema.sql"),
    resolve(__dirname, "../db/schema.sql"),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) throw new Error("db/schema.sql not found");
  await db.query(readFileSync(path, "utf-8"));
  applied = true;
}
