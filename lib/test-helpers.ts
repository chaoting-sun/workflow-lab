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

// Forge a queued SSH task + active SSH lease under a fresh job. The job has
// `pipelinesCount` CPU pending tasks (untouched), one of which is reused as
// the SSH parent. Use pipelinesCount=1 to exercise the barrier-fires path
// after this SSH succeeds; pipelinesCount>1 to exercise the partial path.
export async function makeQueuedSshTaskWithLease(
  userId: string,
  pipelinesCount = 1,
): Promise<QueuedTaskFixture> {
  const job = await createJob({ userId, pipelinesCount });
  const parent = await db.query<{ id: string }>(
    `SELECT id FROM tasks WHERE job_id=$1 AND kind='cpu' ORDER BY created_at LIMIT 1`,
    [job.jobId],
  );
  const ins = await db.query<{ id: string; attempts: number }>(
    `INSERT INTO tasks (job_id, user_id, kind, status, parent_task_id)
       VALUES ($1, $2, 'ssh', 'queued', $3)
       RETURNING id, attempts`,
    [job.jobId, userId, parent.rows[0].id],
  );
  const taskId = ins.rows[0].id;
  const attempts = ins.rows[0].attempts;
  const lease = await db.query<{ id: string }>(
    `INSERT INTO leases (task_id, user_id, resource, expires_at)
       VALUES ($1, $2, 'ssh', now() + interval '1 minute')
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
