import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://workflow:workflow@localhost:5432/workflow_lab";

const SCHEMA_SQL = readFileSync(
  join(__dirname, "schema.sql"),
  "utf-8",
);

const pool = new Pool({ connectionString: DATABASE_URL });

async function dropAll(): Promise<void> {
  await pool.query(`
    DROP TABLE IF EXISTS leases     CASCADE;
    DROP TABLE IF EXISTS artifacts  CASCADE;
    DROP TABLE IF EXISTS tasks      CASCADE;
    DROP TABLE IF EXISTS jobs       CASCADE;
    DROP TABLE IF EXISTS users      CASCADE;
  `);
}

beforeAll(async () => {
  await dropAll();
  await pool.query(SCHEMA_SQL);
});

afterAll(async () => {
  await dropAll();
  await pool.end();
});

async function insertUser(name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (name) VALUES ($1) RETURNING id`,
    [name],
  );
  return rows[0].id;
}

async function insertJob(userId: string, pipelinesCount: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO jobs (user_id, pipelines_count) VALUES ($1, $2) RETURNING id`,
    [userId, pipelinesCount],
  );
  return rows[0].id;
}

async function insertTask(opts: {
  jobId: string;
  userId: string;
  kind: "cpu" | "ssh" | "training";
  parentTaskId?: string | null;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (job_id, user_id, kind, parent_task_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [opts.jobId, opts.userId, opts.kind, opts.parentTaskId ?? null],
  );
  return rows[0].id;
}

describe("db/schema.sql", () => {
  it("creates all required tables", async () => {
    const { rows } = await pool.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public'
      ORDER BY table_name
    `);
    const names = rows.map((r) => r.table_name);
    expect(names).toEqual(
      expect.arrayContaining(["users", "jobs", "tasks", "artifacts", "leases"]),
    );
  });

  it("tasks has attempts, max_attempts, failure_reason, parent_task_id", async () => {
    const { rows } = await pool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='tasks' AND table_schema='public'
    `);
    const cols = rows.map((r) => r.column_name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "attempts",
        "max_attempts",
        "failure_reason",
        "parent_task_id",
      ]),
    );
  });

  it("leases has acquired_at, heartbeat_at, expires_at, released_at", async () => {
    const { rows } = await pool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='leases' AND table_schema='public'
    `);
    const cols = rows.map((r) => r.column_name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "acquired_at",
        "heartbeat_at",
        "expires_at",
        "released_at",
      ]),
    );
  });

  it("rejects jobs.pipelines_count = 0", async () => {
    const userId = await insertUser("alice0");
    await expect(insertJob(userId, 0)).rejects.toThrow(/pipelines_count/);
  });

  it("rejects jobs.pipelines_count = 1001", async () => {
    const userId = await insertUser("alice1");
    await expect(insertJob(userId, 1001)).rejects.toThrow(/pipelines_count/);
  });

  it("accepts jobs.pipelines_count at 1 and 1000", async () => {
    const userId = await insertUser("alice2");
    await expect(insertJob(userId, 1)).resolves.toBeTruthy();
    await expect(insertJob(userId, 1000)).resolves.toBeTruthy();
  });

  it("partial unique: two SSH tasks with same parent_task_id are rejected", async () => {
    const userId = await insertUser("bob");
    const jobId = await insertJob(userId, 5);
    const cpuId = await insertTask({ jobId, userId, kind: "cpu" });
    await insertTask({ jobId, userId, kind: "ssh", parentTaskId: cpuId });
    await expect(
      insertTask({ jobId, userId, kind: "ssh", parentTaskId: cpuId }),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("partial unique does NOT block two non-SSH tasks sharing parent_task_id", async () => {
    const userId = await insertUser("carol");
    const jobId = await insertJob(userId, 5);
    const cpuId = await insertTask({ jobId, userId, kind: "cpu" });
    await expect(
      insertTask({ jobId, userId, kind: "cpu", parentTaskId: cpuId }),
    ).resolves.toBeTruthy();
    await expect(
      insertTask({ jobId, userId, kind: "cpu", parentTaskId: cpuId }),
    ).resolves.toBeTruthy();
  });

  it("artifacts UNIQUE(task_id): second insert for same task fails", async () => {
    const userId = await insertUser("dave");
    const jobId = await insertJob(userId, 1);
    const taskId = await insertTask({ jobId, userId, kind: "ssh" });
    await pool.query(
      `INSERT INTO artifacts (task_id, path) VALUES ($1, '/tmp/a')`,
      [taskId],
    );
    await expect(
      pool.query(
        `INSERT INTO artifacts (task_id, path) VALUES ($1, '/tmp/b')`,
        [taskId],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("expected hot-query indexes exist", async () => {
    const { rows } = await pool.query<{ indexdef: string; indexname: string }>(`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public'
    `);
    const defs = new Map(rows.map((r) => [r.indexname, r.indexdef.toLowerCase()]));

    expect(defs.get("tasks_kind_status_user_idx")).toMatch(
      /\(kind, status, user_id\)/,
    );
    expect(defs.get("leases_resource_released_idx")).toMatch(
      /\(resource, released_at\)/,
    );
    const sshParent = defs.get("tasks_ssh_parent_unique_idx");
    expect(sshParent).toMatch(/\(parent_task_id\)/);
    expect(sshParent).toMatch(/where.*kind = 'ssh'/);
  });

  it("schema is idempotent — re-applying does not error", async () => {
    await expect(pool.query(SCHEMA_SQL)).resolves.toBeTruthy();
  });
});
