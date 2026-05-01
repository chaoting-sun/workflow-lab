import { afterAll, describe, expect, it } from "vitest";
import { db, closeDb } from "./db";

afterAll(async () => {
  await closeDb();
});

describe("db.query", () => {
  it("executes a simple parameterised query", async () => {
    const { rows } = await db.query<{ n: number }>("SELECT $1::int AS n", [42]);
    expect(rows[0].n).toBe(42);
  });
});

describe("db.tx", () => {
  it("commits when the callback resolves", async () => {
    const result = await db.tx(async (tx) => {
      const { rows } = await tx.query<{ v: number }>("SELECT 7 AS v");
      return rows[0].v;
    });
    expect(result).toBe(7);
  });

  it("rolls back when the callback throws", async () => {
    // Use a temp table created inside the tx; if rollback works, the table
    // should not exist after the tx ends.
    const tableName = `tx_rollback_probe_${Date.now()}`;
    await expect(
      db.tx(async (tx) => {
        await tx.query(`CREATE TABLE ${tableName} (id int)`);
        throw new Error("force-rollback");
      }),
    ).rejects.toThrow("force-rollback");

    const { rows } = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema='public' AND table_name=$1
       ) AS exists`,
      [tableName],
    );
    expect(rows[0].exists).toBe(false);
  });

  it("uses the same connection for all queries in the callback", async () => {
    // pg_backend_pid() is per-connection; both queries on the tx client must
    // return the same pid.
    const [pid1, pid2] = await db.tx(async (tx) => {
      const a = await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const b = await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      return [a.rows[0].pid, b.rows[0].pid];
    });
    expect(pid1).toBe(pid2);
  });
});
