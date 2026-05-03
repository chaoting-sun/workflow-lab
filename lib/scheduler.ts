import { db } from "./db";
import { getConfig } from "./config";
import { failJob } from "./jobs";
import { releaseLease } from "./worker";

export interface DispatchMessage {
  taskId: string;
  leaseId: string;
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

// `kind` doubles as the leases.resource value: every CPU lease tracks CPU
// slot usage, every SSH lease tracks SSH slot usage, every training lease
// tracks training slot usage. Each kind has its own independent slot pool.

// Picks the next pending task of `kind` using fairness ordering (least active
// leases of the same resource per user, then oldest job, then oldest task),
// creates a lease, and flips the task to 'queued' — all in one transaction.
// Caller enqueues to BullMQ outside the transaction: never hold a DB
// transaction open across a BullMQ enqueue.
async function reserveOneTask(
  kind: DispatchKind,
  leaseTtlMs: number,
): Promise<DispatchMessage | null> {
  return db.tx(async (tx) => {
    // Fairness ordering, evaluated per candidate row before SKIP LOCKED:
    //   1. active leases of this resource for the candidate's user (cross-user
    //      fairness — one user's active load can't block another user).
    //   2. active leases of this resource for the candidate's job (same-user
    //      fairness — two jobs from one user interleave instead of A draining
    //      before B starts).
    const pick = await tx.query<{
      task_id: string;
      user_id: string;
      attempts: number;
    }>(
      `SELECT t.id AS task_id, t.user_id, t.attempts
         FROM tasks t
         JOIN jobs j ON j.id = t.job_id
        WHERE t.kind = $1 AND t.status = 'pending'
        ORDER BY (
                  SELECT count(*) FROM leases l
                   WHERE l.user_id = t.user_id
                     AND l.resource = $1
                     AND l.released_at IS NULL
                ) ASC,
                 (
                  SELECT count(*) FROM leases l
                    JOIN tasks lt ON lt.id = l.task_id
                   WHERE lt.job_id = t.job_id
                     AND l.resource = $1
                     AND l.released_at IS NULL
                ) ASC,
                 j.created_at ASC,
                 t.created_at ASC
        LIMIT 1
        FOR UPDATE OF t SKIP LOCKED`,
      [kind],
    );
    if (pick.rowCount === 0) return null;
    const row = pick.rows[0];

    const lease = await tx.query<{ id: string }>(
      `INSERT INTO leases (task_id, user_id, resource, expires_at)
            VALUES ($1, $2, $3, now() + ($4::bigint * interval '1 millisecond'))
         RETURNING id`,
      [row.task_id, row.user_id, kind, leaseTtlMs],
    );

    await tx.query(`UPDATE tasks SET status='queued' WHERE id=$1`, [
      row.task_id,
    ]);

    return {
      taskId: row.task_id,
      attempts: row.attempts,
      leaseId: lease.rows[0].id,
    };
  });
}

async function countActiveLeases(resource: DispatchKind): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM leases
      WHERE resource = $1 AND released_at IS NULL`,
    [resource],
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

// Crash safety: if `queue.add` throws after the lease has been committed, the
// task is left as 'queued' with an active lease but no BullMQ message. The
// reaper resets it on lease expiry. We propagate the error so the caller stops
// the loop early — re-trying here would only pile up orphan leases against a
// broken queue.
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

// Death-detection: a lease whose `expires_at` slipped past now() without
// `released_at` being set means the worker stopped heartbeating (process
// crash, hang, GC stall past the TTL). The reaper runs once per scheduler
// tick, BEFORE dispatch, so freed slots are visible to fairness counting in
// the same tick.
//
// `attempts` is NOT incremented here — the next claimTask bumps it. If we
// also bumped here, an honest worker that resumes after a brief pause and
// finalizes (passing the optimistic-lock check) would have its successful
// finalize counted as one extra attempt against max_attempts.
//
// Permanent failure (attempts >= max_attempts) propagates to jobs.status so
// downstream consumers stop waiting on a barrier that can never fire.
export async function reapExpiredLeases(): Promise<number> {
  return db.tx(async (tx) => {
    const expired = await tx.query<{
      lease_id: string;
      task_id: string;
      job_id: string;
      attempts: number;
      max_attempts: number;
    }>(
      `SELECT l.id AS lease_id, l.task_id, t.job_id,
              t.attempts, t.max_attempts
         FROM leases l
         JOIN tasks t ON t.id = l.task_id
        WHERE l.released_at IS NULL
          AND l.expires_at < now()
        FOR UPDATE OF l SKIP LOCKED`,
    );

    for (const row of expired.rows) {
      const retryable = row.attempts < row.max_attempts;
      if (retryable) {
        await tx.query(
          `UPDATE tasks
              SET status='pending', started_at=NULL
            WHERE id=$1 AND status IN ('queued','running')`,
          [row.task_id],
        );
      } else {
        await tx.query(
          `UPDATE tasks
              SET status='failed',
                  failure_reason='lease_expired',
                  finished_at=now()
            WHERE id=$1 AND status NOT IN ('succeeded','failed')`,
          [row.task_id],
        );
        await failJob(tx, row.job_id);
      }
      await releaseLease(tx, row.lease_id);
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
  // and training dispatch touch disjoint leases.resource values and disjoint
  // tasks.kind rows, so they share no row-level locks and can run in parallel
  // within a single scheduler instance.
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
