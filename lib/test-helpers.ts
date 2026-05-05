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
  leaseToken: string;
  attempts: number;
  userId: string;
}

// Forge a (queued task + active lease) pair so worker tests can exercise
// claim/finalize without booting the scheduler.
async function leaseTask(taskId: string): Promise<string> {
  const { rows } = await db.query<{ lease_token: string }>(
    `UPDATE tasks
        SET status='queued',
            lease_token=gen_random_uuid(),
            lease_expires_at=now() + interval '1 minute',
            lease_heartbeat_at=now()
      WHERE id=$1
      RETURNING lease_token`,
    [taskId],
  );
  return rows[0].lease_token;
}

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
  const leaseToken = await leaseTask(taskId);
  return { jobId: job.jobId, taskId, leaseToken, attempts, userId };
}

// Forge a queued training task + active lease under a fresh job.
// Bypasses the barrier / SSH stages — used by training-worker tests that
// only care about the claim/finalize transition.
export async function makeQueuedTrainingTaskWithLease(
  userId: string,
): Promise<QueuedTaskFixture> {
  const job = await createJob({ userId, pipelinesCount: 1 });
  const ins = await db.query<{ id: string; attempts: number }>(
    `INSERT INTO tasks (job_id, user_id, kind, status)
       VALUES ($1, $2, 'training', 'queued')
       RETURNING id, attempts`,
    [job.jobId, userId],
  );
  const taskId = ins.rows[0].id;
  const attempts = ins.rows[0].attempts;
  const leaseToken = await leaseTask(taskId);
  return { jobId: job.jobId, taskId, leaseToken, attempts, userId };
}

// Forge a queued CPU task whose lease has already expired (lease_expires_at
// in the past). Used by reaper tests; `attempts`/`maxAttempts` overrides
// drive the retryable vs terminal branches.
export async function makeQueuedCpuTaskWithExpiredLease(
  userId: string,
  opts: { attempts?: number; maxAttempts?: number } = {},
): Promise<QueuedTaskFixture> {
  const job = await createJob({ userId, pipelinesCount: 1 });
  const t = await db.query<{ id: string }>(
    `SELECT id FROM tasks WHERE job_id=$1 LIMIT 1`,
    [job.jobId],
  );
  const taskId = t.rows[0].id;
  const upd = await db.query<{ lease_token: string; attempts: number }>(
    `UPDATE tasks
        SET status='queued',
            attempts=$2,
            max_attempts=$3,
            lease_token=gen_random_uuid(),
            lease_expires_at=now() - interval '1 second',
            lease_heartbeat_at=now() - interval '5 seconds'
      WHERE id=$1
      RETURNING lease_token, attempts`,
    [taskId, opts.attempts ?? 0, opts.maxAttempts ?? 3],
  );
  return {
    jobId: job.jobId,
    taskId,
    leaseToken: upd.rows[0].lease_token,
    attempts: upd.rows[0].attempts,
    userId,
  };
}

// Forge a queued SSH task + active lease under a fresh job. The job has
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
  const leaseToken = await leaseTask(taskId);
  return { jobId: job.jobId, taskId, leaseToken, attempts, userId };
}
