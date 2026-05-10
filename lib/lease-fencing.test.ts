import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "./db";
import { ensureSchema } from "./test-helpers";
import { createUser } from "./users";
import { createJob } from "./jobs";
import {
  dispatchCpu,
  reapExpiredLeases,
  type DispatchMessage,
  type DispatchQueue,
} from "./scheduler";
import { claimTask } from "./worker";

const PREFIX = `t23-fence-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

class CapturingQueue implements DispatchQueue {
  messages: DispatchMessage[] = [];
  async add(msg: DispatchMessage): Promise<void> {
    this.messages.push(msg);
  }
}

async function reset(): Promise<void> {
  await db.query(`DELETE FROM users WHERE name LIKE $1`, [`${PREFIX}%`]);
}

beforeAll(async () => {
  await ensureSchema();
  await reset();
});

beforeEach(reset);

afterAll(async () => {
  await reset();
  await closeDb();
});

// Reproduces the race the `lease_token = $token` predicate in claimTask is
// designed to close: a dispatched message survives lease expiry + reap +
// re-dispatch, leaving two BullMQ messages in flight that both reference the
// same task. Concurrent claims must yield exactly one winner — the one whose
// token still matches the row.
describe("lease_token fencing under reap-and-redispatch", () => {
  it("rejects the stale-token claim and accepts the fresh-token claim (×10)", async () => {
    for (let i = 0; i < 10; i++) {
      // Reset between iterations: the lingering running-tasks from prior
      // iterations would otherwise consume the global CPU slot pool and
      // make dispatchCpu return 0 once the pool is small (GLOBAL_CPU_SLOTS=4).
      await reset();
      const user = await createUser(`${PREFIX}-iter${i}`);
      const job = await createJob({ userId: user.id, pipelinesCount: 1 });

      const queue1 = new CapturingQueue();
      expect(await dispatchCpu(queue1)).toBe(1);
      const messageA = queue1.messages[0];

      // Force lease expiry deterministically — no setTimeout, no real wait.
      await db.query(
        `UPDATE tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
        [messageA.taskId],
      );

      // attempts is preserved across reap (the next claim bumps it),
      // so messageA and messageB observe the same `attempts` value.
      expect(await reapExpiredLeases()).toBe(1);

      const queue2 = new CapturingQueue();
      expect(await dispatchCpu(queue2)).toBe(1);
      const messageB = queue2.messages[0];
      expect(messageB.taskId).toBe(messageA.taskId);
      expect(messageB.leaseToken).not.toBe(messageA.leaseToken);
      expect(messageB.attempts).toBe(messageA.attempts);

      const [resA, resB] = await Promise.all([
        claimTask(messageA),
        claimTask(messageB),
      ]);

      expect(resA).toBeNull();
      expect(resB).not.toBeNull();
      expect(resB!.taskId).toBe(messageA.taskId);
      expect(resB!.jobId).toBe(job.jobId);
      expect(resB!.userId).toBe(user.id);
      expect(resB!.myAttempts).toBe(messageA.attempts + 1);

      const row = await db.query<{
        status: string;
        attempts: number;
        lease_token: string | null;
      }>(
        `SELECT status, attempts, lease_token FROM tasks WHERE id=$1`,
        [messageA.taskId],
      );
      expect(row.rows[0].status).toBe("running");
      expect(row.rows[0].attempts).toBe(messageA.attempts + 1);
      expect(row.rows[0].lease_token).toBe(messageB.leaseToken);
    }
  });
});
