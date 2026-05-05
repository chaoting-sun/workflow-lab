import { db, type Queryable } from "./db";
import { getConfig } from "./config";
import { runBarrierCheck } from "./barrier";
import { failJob } from "./jobs";
import { TimeoutError } from "./timeout";

export interface HeartbeatHandle {
  stop(): void;
}

export interface HeartbeatOptions {
  intervalMs?: number;
  ttlMs?: number;
}

// The reaper treats `lease_expires_at < now() AND lease columns set` as
// "worker is dead", so a live worker must keep pushing lease_expires_at
// forward. The `lease_token = $2` predicate means we never resurrect a
// lease that the finalize tx has released — a released lease has
// `lease_token=NULL`, so the UPDATE is a no-op.
export function startHeartbeat(
  taskId: string,
  leaseToken: string,
  opts: HeartbeatOptions = {},
): HeartbeatHandle {
  const cfg = getConfig();
  const intervalMs = opts.intervalMs ?? cfg.LEASE_HEARTBEAT_MS;
  const ttlMs = opts.ttlMs ?? cfg.LEASE_TTL_MS;

  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await db.query(
        `UPDATE tasks
            SET lease_heartbeat_at = now(),
                lease_expires_at   = now() + ($3::bigint * interval '1 millisecond')
          WHERE id = $1 AND lease_token = $2`,
        [taskId, leaseToken, ttlMs],
      );
    } catch (err) {
      // Heartbeat failure must never crash the worker process. Log and
      // continue — the next tick will retry. If the DB is durably broken
      // the lease will eventually expire and the reaper will pick it up.
      console.error(`heartbeat for task ${taskId} failed:`, err);
    }
  };

  // Chain ticks instead of firing them concurrently. If a tick stalls past
  // intervalMs (DB blip), naive setInterval would pile up parallel UPDATEs
  // and exhaust the pool; the chain serialises them so a stall costs at
  // most one in-flight query.
  let chain: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    chain = chain.then(tick);
  }, intervalMs);

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export interface WorkerTaskMessage {
  taskId: string;
  leaseToken: string;
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
// (status moved on, attempts moved on, or the lease was released and a new
// dispatch issued a different token); a null return is the caller's signal
// to silently abort. The job-status promotion is gated on `status='pending'`
// for idempotency across re-claims and so it never overwrites a terminal
// 'completed'/'failed' state — and on `id IN (SELECT job_id FROM claimed)`
// so a rejected claim leaves jobs untouched. Both UPDATEs run in one CTE
// statement, so claim + promotion commit (or roll back) together with a
// single round-trip.
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
          AND lease_token = $3
        RETURNING attempts, job_id, user_id
     ), job_promoted AS (
       UPDATE jobs SET status='running'
        WHERE id IN (SELECT job_id FROM claimed) AND status = 'pending'
     )
     SELECT attempts, job_id, user_id FROM claimed`,
    [msg.taskId, msg.attempts, msg.leaseToken],
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

// Optimistic-locked success write. Gated on `attempts=myAttempts` so a
// concurrent reaper / parallel worker that bumped attempts since the claim
// leaves no side effects: we throw StaleAttemptError, the tx rolls back, and
// the caller swallows it. Used by all three finalizeXSuccess paths.
async function markTaskSucceeded(
  tx: Queryable,
  claimed: ClaimedTask,
): Promise<void> {
  const upd = await tx.query(
    `UPDATE tasks
        SET status='succeeded',
            finished_at=now(),
            lease_token=NULL,
            lease_expires_at=NULL,
            lease_heartbeat_at=NULL
      WHERE id=$1 AND attempts=$2 AND status='running'
      RETURNING id`,
    [claimed.taskId, claimed.myAttempts],
  );
  if (upd.rowCount === 0) throw new StaleAttemptError();
}

export async function finalizeCpuSuccess(
  claimed: ClaimedTask,
  artifactPath: string,
): Promise<void> {
  await db.tx(async (tx) => {
    await markTaskSucceeded(tx, claimed);

    await tx.query(
      `INSERT INTO artifacts (task_id, path)
         VALUES ($1, $2)
         ON CONFLICT (task_id) DO NOTHING`,
      [claimed.taskId, artifactPath],
    );

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

// Job-completion is the only side effect outside the task row: the
// `status NOT IN ('completed','failed')` guard makes it idempotent across
// re-deliveries and prevents a successful retry from clobbering a job that
// was already permanently failed.
export async function finalizeTrainingSuccess(
  claimed: ClaimedTask,
): Promise<void> {
  await db.tx(async (tx) => {
    await markTaskSucceeded(tx, claimed);

    await tx.query(
      `UPDATE jobs
          SET status='completed', completed_at=now()
        WHERE id=$1 AND status NOT IN ('completed','failed')`,
      [claimed.jobId],
    );
  });
}

// Worker-side failure finalize. Writes status='pending' (retryable) or
// 'failed' (terminal) along with failure_reason in one optimistic-locked
// UPDATE that also clears the lease columns; on a terminal failure,
// propagates jobs.status='failed' so barriers waiting on the dead task
// don't hang forever.
//
// Returns false if the optimistic guard rejected the write (a parallel reaper
// or worker mutated `attempts` since our claim), true otherwise. The caller
// should treat false as "another actor handled the outcome — drop it".
export async function finalizeTaskFailure(
  claimed: ClaimedTask,
  reason: string,
): Promise<boolean> {
  return db.tx(async (tx) => {
    // The CASE branches read max_attempts from the same row the WHERE clause
    // matched, so we never race a concurrent UPDATE of max_attempts.
    // On terminal failure started_at is preserved for audit; on retry it is
    // reset so the next claim's started_at reflects the actual run start.
    const upd = await tx.query<{ status: string }>(
      `UPDATE tasks
          SET status = CASE
                         WHEN attempts >= max_attempts THEN 'failed'
                         ELSE 'pending'
                       END,
              failure_reason = $3,
              finished_at = CASE
                              WHEN attempts >= max_attempts THEN now()
                              ELSE NULL
                            END,
              started_at = CASE
                             WHEN attempts >= max_attempts THEN started_at
                             ELSE NULL
                           END,
              lease_token = NULL,
              lease_expires_at = NULL,
              lease_heartbeat_at = NULL
        WHERE id=$1 AND attempts=$2 AND status='running'
        RETURNING status`,
      [claimed.taskId, claimed.myAttempts, reason],
    );
    if (upd.rowCount === 0) return false;

    if (upd.rows[0].status === "failed") {
      await failJob(tx, claimed.jobId);
    }
    return true;
  });
}

function failureReason(err: unknown): string {
  if (err instanceof TimeoutError) return err.kind;
  return "error";
}

// Worker-side wrapper around finalizeTaskFailure: maps the thrown error to a
// failure_reason and swallows DB errors from the failure path itself. The
// failure path must NOT bubble to BullMQ — that would mark the queue job
// failed and desync from our DB-as-source-of-truth model. A truly broken
// finalize is left to the lease reaper.
export async function recordFailure(
  claimed: ClaimedTask,
  err: unknown,
): Promise<void> {
  try {
    await finalizeTaskFailure(claimed, failureReason(err));
  } catch (failErr) {
    console.error(
      `finalizeTaskFailure failed for task ${claimed.taskId}:`,
      failErr,
    );
  }
}

// The barrier check may insert a single training task once every SSH artifact
// for the job is present; see lib/barrier.ts for serialisation guarantees.
export async function finalizeSshSuccess(
  claimed: ClaimedTask,
  artifactPath: string,
): Promise<void> {
  await db.tx(async (tx) => {
    await markTaskSucceeded(tx, claimed);

    await tx.query(
      `INSERT INTO artifacts (task_id, path)
         VALUES ($1, $2)
         ON CONFLICT (task_id) DO NOTHING`,
      [claimed.taskId, artifactPath],
    );

    await runBarrierCheck(tx, claimed.jobId);
  });
}
