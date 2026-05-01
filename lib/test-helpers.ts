import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "./db";
import { createJob } from "./jobs";

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

export interface QueuedTaskFixture {
  jobId: string;
  taskId: string;
  leaseId: string;
  attempts: number;
  userId: string;
}

// Forge a (queued task + active CPU lease) pair so worker tests can exercise
// claim/finalize without booting the scheduler.
export async function makeQueuedCpuTaskWithLease(
  userId: string,
): Promise<QueuedTaskFixture> {
  const job = await createJob({ userId, pipelinesCount: 1 });
  const t = await db.query<{ id: string; attempts: number }>(
    `SELECT id, attempts FROM tasks WHERE job_id=$1 LIMIT 1`,
    [job.jobId],
  );
  const taskId = t.rows[0].id;
  const attempts = t.rows[0].attempts;
  await db.query(`UPDATE tasks SET status='queued' WHERE id=$1`, [taskId]);
  const lease = await db.query<{ id: string }>(
    `INSERT INTO leases (task_id, user_id, resource, expires_at)
       VALUES ($1, $2, 'cpu', now() + interval '1 minute')
       RETURNING id`,
    [taskId, userId],
  );
  return {
    jobId: job.jobId,
    taskId,
    leaseId: lease.rows[0].id,
    attempts,
    userId,
  };
}
