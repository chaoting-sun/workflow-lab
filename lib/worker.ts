import { db } from "./db";
import { getConfig } from "./config";

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

// Atomic claim: flips queued→running and bumps attempts in one statement.
// The compound WHERE rejects stale BullMQ deliveries — status moved on,
// attempts moved on, or the lease was released. A null return is the
// caller's signal to silently abort.
export async function claimTask(
  msg: WorkerTaskMessage,
): Promise<ClaimedTask | null> {
  const result = await db.query<{
    attempts: number;
    job_id: string;
    user_id: string;
  }>(
    `UPDATE tasks
        SET status='running', started_at=now(), attempts=attempts+1
      WHERE id = $1
        AND status = 'queued'
        AND attempts = $2
        AND EXISTS (
          SELECT 1 FROM leases
           WHERE id = $3 AND task_id = $1 AND released_at IS NULL
        )
      RETURNING attempts, job_id, user_id`,
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

    await tx.query(`UPDATE leases SET released_at=now() WHERE id=$1`, [
      leaseId,
    ]);

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
