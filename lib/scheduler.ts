import { db } from "./db";
import { getConfig } from "./config";
import { failJob } from "./jobs";

export interface DispatchMessage {
  taskId: string;
  leaseToken: string;
  attempts: number;
}

export interface DispatchQueue {
  add(payload: DispatchMessage): Promise<void>;
}

export interface SchedulerQueues {
  cpu: DispatchQueue;
  ssh?: DispatchQueue;
  training?: DispatchQueue;
}

type DispatchKind = "cpu" | "ssh" | "training";

// Caller enqueues to BullMQ outside the DB call: never hold a DB transaction
// open across a BullMQ enqueue.
//
// Sole writer of `status='queued'` from `pending`. Composed with the reaper's
// `running → pending` step, both writes leave `attempts` untouched —
// see docs/03-design/task-lifecycle.md "running → queued puzzle".
async function reserveOneTask(
  kind: DispatchKind,
  leaseTtlMs: number,
): Promise<DispatchMessage | null> {
  // Fairness ordering, evaluated per candidate row before SKIP LOCKED:
  //   1. active leases of this kind for the candidate's user (cross-user
  //      fairness — one user's active load can't block another user).
  //   2. active leases of this kind for the candidate's job (same-user
  //      fairness — two jobs from one user interleave instead of A draining
  //      before B starts).
  const result = await db.query<{
    task_id: string;
    attempts: number;
    lease_token: string;
  }>(
    `WITH pick AS (
       SELECT t.id, t.attempts
         FROM tasks t
         JOIN jobs j ON j.id = t.job_id
        WHERE t.kind = $1 AND t.status = 'pending'
        ORDER BY (
                  SELECT count(*) FROM tasks lt
                   WHERE lt.user_id = t.user_id
                     AND lt.kind = $1
                     AND lt.lease_token IS NOT NULL
                ) ASC,
                 (
                  SELECT count(*) FROM tasks lt
                   WHERE lt.job_id = t.job_id
                     AND lt.kind = $1
                     AND lt.lease_token IS NOT NULL
                ) ASC,
                 j.created_at ASC,
                 t.created_at ASC
        LIMIT 1
        FOR UPDATE OF t SKIP LOCKED
     )
     UPDATE tasks
        SET status = 'queued',
            lease_token = gen_random_uuid(),
            lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
            lease_heartbeat_at = now()
       FROM pick
      WHERE tasks.id = pick.id
      RETURNING tasks.id AS task_id, pick.attempts, tasks.lease_token`,
    [kind, leaseTtlMs],
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return {
    taskId: row.task_id,
    attempts: row.attempts,
    leaseToken: row.lease_token,
  };
}

async function countActiveLeases(kind: DispatchKind): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM tasks
      WHERE kind = $1 AND lease_token IS NOT NULL`,
    [kind],
  );
  return Number(rows[0].count);
}

async function countSshBacklog(): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM tasks
      WHERE kind='ssh' AND status IN ('pending','queued','running')`,
  );
  return Number(rows[0].count);
}

// Crash safety: if `queue.add` throws after the reserve UPDATE has been
// committed, the task is left as 'queued' with an active lease but no BullMQ
// message. The reaper resets it on lease expiry. We propagate the error so
// the caller stops the loop early — re-trying here would only pile up orphan
// leases against a broken queue.
async function dispatchKind(
  queue: DispatchQueue,
  kind: DispatchKind,
  slotsCap: number,
): Promise<number> {
  const cfg = getConfig();
  const used = await countActiveLeases(kind);
  const free = slotsCap - used;
  if (free <= 0) return 0;

  let dispatched = 0;
  for (let i = 0; i < free; i++) {
    const reserved = await reserveOneTask(kind, cfg.LEASE_TTL_MS);
    if (!reserved) break;

    await queue.add(reserved);
    dispatched++;
  }
  return dispatched;
}

// Death-detection: a row whose `lease_expires_at` slipped past now() without
// the lease being released (lease_token NULLed) means the worker stopped
// heartbeating (process crash, hang, GC stall past the TTL). The reaper runs
// once per scheduler tick, BEFORE dispatch, so freed slots are visible to
// fairness counting in the same tick.
//
// `attempts` is NOT incremented here — the next claimTask bumps it. If we
// also bumped here, an honest worker that resumes after a brief pause and
// finalizes (passing the optimistic-lock check) would have its successful
// finalize counted as one extra attempt against max_attempts.
// Consequence: a `running → pending → queued` cycle (reap then re-dispatch)
// preserves `attempts`, which is the diagnostic fingerprint described in
// docs/03-design/task-lifecycle.md "running → queued puzzle".
//
// Permanent failure (attempts >= max_attempts) propagates to jobs.status so
// downstream consumers stop waiting on a barrier that can never fire.
export async function reapExpiredLeases(): Promise<number> {
  return db.tx(async (tx) => {
    // Lock expired rows up-front so a parallel reaper or worker can't
    // double-process them.
    const expired = await tx.query<{
      task_id: string;
      job_id: string;
      retryable: boolean;
    }>(
      `SELECT id AS task_id, job_id, (attempts < max_attempts) AS retryable
         FROM tasks
        WHERE lease_expires_at < now()
          AND status IN ('queued','running')
        FOR UPDATE SKIP LOCKED`,
    );
    if (expired.rowCount === 0) return 0;

    const retryableIds: string[] = [];
    const failedJobIds: string[] = [];
    const failedTaskIds: string[] = [];
    for (const row of expired.rows) {
      if (row.retryable) {
        retryableIds.push(row.task_id);
      } else {
        failedTaskIds.push(row.task_id);
        failedJobIds.push(row.job_id);
      }
    }

    if (retryableIds.length > 0) {
      await tx.query(
        `UPDATE tasks
            SET status='pending',
                started_at=NULL,
                lease_token=NULL,
                lease_expires_at=NULL,
                lease_heartbeat_at=NULL
          WHERE id = ANY($1::uuid[])
            AND status IN ('queued','running')`,
        [retryableIds],
      );
    }

    if (failedTaskIds.length > 0) {
      await tx.query(
        `UPDATE tasks
            SET status='failed',
                failure_reason='lease_expired',
                finished_at=now(),
                lease_token=NULL,
                lease_expires_at=NULL,
                lease_heartbeat_at=NULL
          WHERE id = ANY($1::uuid[])
            AND status NOT IN ('succeeded','failed')`,
        [failedTaskIds],
      );
      // failJob is idempotent (gated on status NOT IN ('completed','failed'))
      // so deduping the job_id list is a perf nicety, not a correctness need.
      const uniqueJobIds = Array.from(new Set(failedJobIds));
      for (const jobId of uniqueJobIds) {
        await failJob(tx, jobId);
      }
    }

    return expired.rowCount ?? 0;
  });
}

export async function dispatchCpu(queue: DispatchQueue): Promise<number> {
  // Pause CPU production when the SSH backlog reaches the threshold.
  // Without this gate, CPU work outpaces SSH and pending SSH grows
  // unbounded; the trade-off is global rather than per-user fairness.
  const cfg = getConfig();
  const backlog = await countSshBacklog();
  if (backlog >= cfg.SSH_BACKPRESSURE_THRESHOLD) return 0;
  return dispatchKind(queue, "cpu", cfg.GLOBAL_CPU_SLOTS);
}

export async function dispatchSsh(queue: DispatchQueue): Promise<number> {
  return dispatchKind(queue, "ssh", getConfig().GLOBAL_SSH_SLOTS);
}

export async function dispatchTraining(queue: DispatchQueue): Promise<number> {
  return dispatchKind(queue, "training", getConfig().GLOBAL_TRAINING_SLOTS);
}

export interface SchedulerLoopOptions {
  queues: SchedulerQueues;
  intervalMs: number;
  onError?: (err: unknown) => void;
}

export interface SchedulerLoopHandle {
  stop(): Promise<void>;
}

// Starts the scheduler tick loop. Returns a handle whose `stop()` waits for
// the in-flight tick (if any) to finish before resolving.
export function runSchedulerLoop(
  opts: SchedulerLoopOptions,
): SchedulerLoopHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const onError =
    opts.onError ?? ((err) => console.error("scheduler tick failed:", err));

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(loop, opts.intervalMs);
  };

  // Reap first so freed slots are counted in this tick's dispatch. CPU, SSH
  // and training dispatch touch disjoint kinds and so share no row-level
  // locks — they can run in parallel within a single scheduler instance.
  const loop = (): void => {
    inFlight = (async () => {
      try {
        await reapExpiredLeases();
        const work: Promise<unknown>[] = [dispatchCpu(opts.queues.cpu)];
        if (opts.queues.ssh) work.push(dispatchSsh(opts.queues.ssh));
        if (opts.queues.training)
          work.push(dispatchTraining(opts.queues.training));
        await Promise.all(work);
      } catch (err) {
        onError(err);
      }
    })();
    inFlight.finally(schedule);
  };

  // Fire immediately so the first tick doesn't wait a full interval.
  loop();

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await inFlight;
    },
  };
}
