import type { Queryable } from "./db";
import { getConfig } from "./config";

// `SELECT … FOR UPDATE` on the jobs row serialises concurrent SSH finishers
// of the same job; the `NOT EXISTS` guard makes the training-task insert
// idempotent across retried finalizes. Caller must invoke this inside the
// same tx that just inserted the SSH artifact, so the count includes that row.
export async function runBarrierCheck(
  tx: Queryable,
  jobId: string,
): Promise<void> {
  const job = await tx.query<{ pipelines_count: number; user_id: string }>(
    `SELECT pipelines_count, user_id FROM jobs WHERE id=$1 FOR UPDATE`,
    [jobId],
  );
  if (job.rowCount === 0) return;

  const cnt = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM artifacts a
       JOIN tasks t ON t.id = a.task_id
      WHERE t.job_id = $1 AND t.kind = 'ssh'`,
    [jobId],
  );
  if (Number(cnt.rows[0].count) < job.rows[0].pipelines_count) return;

  await tx.query(
    `INSERT INTO tasks (job_id, user_id, kind, status, max_attempts)
       SELECT $1, $2, 'training', 'pending', $3
        WHERE NOT EXISTS (
          SELECT 1 FROM tasks WHERE job_id = $1 AND kind = 'training'
        )`,
    [jobId, job.rows[0].user_id, getConfig().MAX_ATTEMPTS],
  );
}
