import { db, type Queryable } from "./db";
import { getConfig } from "./config";
import { runBarrierCheck } from "./barrier";

export async function releaseLease(
  client: Queryable,
  leaseId: string,
): Promise<void> {
  await client.query(`UPDATE leases SET released_at=now() WHERE id=$1`, [
    leaseId,
  ]);
}

export interface WorkerTaskMessage {
  taskId: string;
  leaseId: string;
  attempts: number;
}

export interface ClaimedTask {
  taskId: string;
  jobId: string;
  userId: string;
  myAttempts: number;
}

export class StaleAttemptError extends Error {
  constructor() {
    super("attempts changed since claim — finalize aborted");
    this.name = "StaleAttemptError";
  }
}

// Atomic claim: the compound WHERE on tasks rejects stale BullMQ deliveries
// (status moved on, attempts moved on, or the lease was released); a null
// return is the caller's signal to silently abort. The job-status promotion
// is gated on `status='pending'` for idempotency across re-claims and so it
// never overwrites a terminal 'completed'/'failed' state — and on
// `id IN (SELECT job_id FROM claimed)` so a rejected claim leaves jobs
// untouched. Both UPDATEs run in one CTE statement, so claim + promotion
// commit (or roll back) together with a single round-trip.
export async function claimTask(
  msg: WorkerTaskMessage,
): Promise<ClaimedTask | null> {
  const result = await db.query<{
    attempts: number;
    job_id: string;
    user_id: string;
  }>(
    `WITH claimed AS (
       UPDATE tasks
          SET status='running', started_at=now(), attempts=attempts+1
        WHERE id = $1
          AND status = 'queued'
          AND attempts = $2
          AND EXISTS (
            SELECT 1 FROM leases
             WHERE id = $3 AND task_id = $1 AND released_at IS NULL
          )
        RETURNING attempts, job_id, user_id
     ), job_promoted AS (
       UPDATE jobs SET status='running'
        WHERE id IN (SELECT job_id FROM claimed) AND status = 'pending'
     )
     SELECT attempts, job_id, user_id FROM claimed`,
    [msg.taskId, msg.attempts, msg.leaseId],
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return {
    taskId: msg.taskId,
    jobId: row.job_id,
    userId: row.user_id,
    myAttempts: row.attempts,
  };
}

// Success transaction for the CPU stage. Every write is gated on
// `attempts=myAttempts` so a concurrent reaper / parallel worker that
// bumped attempts since the claim leaves no side effects: we throw
// StaleAttemptError, the tx rolls back, and the caller swallows it.
export async function finalizeCpuSuccess(
  claimed: ClaimedTask,
  leaseId: string,
  artifactPath: string,
): Promise<void> {
  await db.tx(async (tx) => {
    const upd = await tx.query(
      `UPDATE tasks
          SET status='succeeded', finished_at=now()
        WHERE id=$1 AND attempts=$2 AND status='running'
        RETURNING id`,
      [claimed.taskId, claimed.myAttempts],
    );
    if (upd.rowCount === 0) throw new StaleAttemptError();

    await tx.query(
      `INSERT INTO artifacts (task_id, path)
         VALUES ($1, $2)
         ON CONFLICT (task_id) DO NOTHING`,
      [claimed.taskId, artifactPath],
    );

    await releaseLease(tx, leaseId);

    // Partial unique index on tasks (parent_task_id) WHERE kind='ssh'
    // makes the SSH-child insert idempotent across retried finalizes.
    await tx.query(
      `INSERT INTO tasks (job_id, user_id, kind, status, parent_task_id, max_attempts)
         VALUES ($1, $2, 'ssh', 'pending', $3, $4)
         ON CONFLICT (parent_task_id) WHERE kind = 'ssh' DO NOTHING`,
      [claimed.jobId, claimed.userId, claimed.taskId, getConfig().MAX_ATTEMPTS],
    );
  });
}

// Job-completion is the only side effect outside the task/lease pair: the
// `status NOT IN ('completed','failed')` guard makes it idempotent across
// re-deliveries and prevents a successful retry from clobbering a job that
// was already permanently failed.
export async function finalizeTrainingSuccess(
  claimed: ClaimedTask,
  leaseId: string,
): Promise<void> {
  await db.tx(async (tx) => {
    const upd = await tx.query(
      `UPDATE tasks
          SET status='succeeded', finished_at=now()
        WHERE id=$1 AND attempts=$2 AND status='running'
        RETURNING id`,
      [claimed.taskId, claimed.myAttempts],
    );
    if (upd.rowCount === 0) throw new StaleAttemptError();

    await releaseLease(tx, leaseId);

    await tx.query(
      `UPDATE jobs
          SET status='completed', completed_at=now()
        WHERE id=$1 AND status NOT IN ('completed','failed')`,
      [claimed.jobId],
    );
  });
}

// The barrier check may insert a single training task once every SSH artifact
// for the job is present; see lib/barrier.ts for serialisation guarantees.
export async function finalizeSshSuccess(
  claimed: ClaimedTask,
  leaseId: string,
  artifactPath: string,
): Promise<void> {
  await db.tx(async (tx) => {
    const upd = await tx.query(
      `UPDATE tasks
          SET status='succeeded', finished_at=now()
        WHERE id=$1 AND attempts=$2 AND status='running'
        RETURNING id`,
      [claimed.taskId, claimed.myAttempts],
    );
    if (upd.rowCount === 0) throw new StaleAttemptError();

    await tx.query(
      `INSERT INTO artifacts (task_id, path)
         VALUES ($1, $2)
         ON CONFLICT (task_id) DO NOTHING`,
      [claimed.taskId, artifactPath],
    );

    await releaseLease(tx, leaseId);

    await runBarrierCheck(tx, claimed.jobId);
  });
}
