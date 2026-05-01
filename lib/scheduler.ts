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
  ssh?: DispatchQueue;
}

// `kind` doubles as the leases.resource value: every CPU lease tracks CPU
// slot usage, every SSH lease tracks SSH slot usage. Each kind has its own
// independent slot pool. Training is dispatched separately once that worker
// lands and is not part of this helper's domain.

// Picks the next pending task of `kind` using fairness ordering (least active
// leases of the same resource per user, then oldest job, then oldest task),
// creates a lease, and flips the task to 'queued' — all in one transaction.
// Caller enqueues to BullMQ outside the transaction: never hold a DB
// transaction open across a BullMQ enqueue.
async function reserveOneTask(
  kind: "cpu" | "ssh",
  leaseTtlMs: number,
): Promise<DispatchMessage | null> {
  return db.tx(async (tx) => {
    // Fairness ordering. The correlated subquery counts active leases of the
    // same resource per candidate user, evaluated for each row before
    // SKIP LOCKED applies.
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

async function countActiveLeases(resource: "cpu" | "ssh"): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM leases
      WHERE resource = $1 AND released_at IS NULL`,
    [resource],
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
  kind: "cpu" | "ssh",
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

export async function dispatchCpu(queue: DispatchQueue): Promise<number> {
  return dispatchKind(queue, "cpu", getConfig().GLOBAL_CPU_SLOTS);
}

export async function dispatchSsh(queue: DispatchQueue): Promise<number> {
  return dispatchKind(queue, "ssh", getConfig().GLOBAL_SSH_SLOTS);
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

  // CPU and SSH dispatch touch disjoint leases.resource values and disjoint
  // tasks.kind rows, so they share no row-level locks and can run in parallel
  // within a single scheduler instance.
  const loop = (): void => {
    inFlight = (async () => {
      try {
        const work: Promise<unknown>[] = [dispatchCpu(opts.queues.cpu)];
        if (opts.queues.ssh) work.push(dispatchSsh(opts.queues.ssh));
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
