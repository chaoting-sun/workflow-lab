import { db } from "./db";
import { getConfig } from "./config";

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
}

// Picks the next pending CPU task using fairness ordering (least active CPU
// leases per user, then oldest job, then oldest task), creates a lease, and
// flips the task to 'queued' — all in one transaction. Returns null when no
// eligible task remains. Caller enqueues to BullMQ outside the transaction:
// never hold a DB transaction open across a BullMQ enqueue.
async function reserveOneCpuTask(
  leaseTtlMs: number,
): Promise<DispatchMessage | null> {
  return db.tx(async (tx) => {
    // Fairness ordering. The correlated subquery counts active CPU leases per
    // candidate user, evaluated for each row before SKIP LOCKED applies.
    const pick = await tx.query<{
      task_id: string;
      user_id: string;
      attempts: number;
    }>(
      `SELECT t.id AS task_id, t.user_id, t.attempts
         FROM tasks t
         JOIN jobs j ON j.id = t.job_id
        WHERE t.kind = 'cpu' AND t.status = 'pending'
        ORDER BY (
                  SELECT count(*) FROM leases l
                   WHERE l.user_id = t.user_id
                     AND l.resource = 'cpu'
                     AND l.released_at IS NULL
                ) ASC,
                 j.created_at ASC,
                 t.created_at ASC
        LIMIT 1
        FOR UPDATE OF t SKIP LOCKED`,
    );
    if (pick.rowCount === 0) return null;
    const row = pick.rows[0];

    const lease = await tx.query<{ id: string }>(
      `INSERT INTO leases (task_id, user_id, resource, expires_at)
            VALUES ($1, $2, 'cpu', now() + ($3::bigint * interval '1 millisecond'))
         RETURNING id`,
      [row.task_id, row.user_id, leaseTtlMs],
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

async function countActiveCpuLeases(): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM leases
      WHERE resource = 'cpu' AND released_at IS NULL`,
  );
  return Number(rows[0].count);
}

// Drains free CPU slots and dispatches at most (GLOBAL_CPU_SLOTS - used) tasks
// per call. Returns the number of tasks dispatched.
//
// Crash safety: if `queue.add` throws after the lease has been committed, the
// task is left as 'queued' with an active lease but no BullMQ message. The
// reaper (T10) will reset it on lease expiry. We propagate the error so the
// caller stops the loop early — re-trying inside this function would just
// create more orphan leases against a broken queue.
export async function dispatchCpu(queue: DispatchQueue): Promise<number> {
  const cfg = getConfig();
  const used = await countActiveCpuLeases();
  const free = cfg.GLOBAL_CPU_SLOTS - used;
  if (free <= 0) return 0;

  let dispatched = 0;
  for (let i = 0; i < free; i++) {
    const reserved = await reserveOneCpuTask(cfg.LEASE_TTL_MS);
    if (!reserved) break;

    await queue.add(reserved);
    dispatched++;
  }
  return dispatched;
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

  // One tick: reaper, backpressure, SSH, and training dispatch are stubs at
  // this stage — landed in T10/T12/T7/T8 respectively.
  const loop = (): void => {
    inFlight = (async () => {
      try {
        await dispatchCpu(opts.queues.cpu);
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
