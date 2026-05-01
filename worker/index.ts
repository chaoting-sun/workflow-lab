// Worker process entrypoint.
// Run with: pnpm worker
//
// Boots one scheduler tick loop guarded by the Postgres advisory lock plus an
// empty BullMQ Worker shell for the cpu queue. Real handlers (cpu/ssh/training)
// land in T6/T7/T8.

import { Worker } from "bullmq";
import { acquireSchedulerLock } from "../lib/advisory-lock";
import { getConfig } from "../lib/config";
import { closeDb } from "../lib/db";
import {
  closeQueues,
  cpuDispatchQueue,
  getRedisConnection,
} from "../lib/queues";
import { runSchedulerLoop } from "../lib/scheduler";

async function main(): Promise<void> {
  const cfg = getConfig();

  const lock = await acquireSchedulerLock();
  if (!lock) {
    console.error(
      "scheduler advisory lock not acquired — another instance is running. Exiting.",
    );
    process.exit(1);
  }
  console.log("scheduler lock acquired");

  // Empty CPU worker shell. Real handler lands in T6.
  const cpuWorker = new Worker(
    "cpu",
    async () => {
      // no-op until T6
    },
    {
      connection: getRedisConnection(),
      lockDuration: cfg.BULLMQ_LOCK_DURATION_MS,
    },
  );

  const loop = runSchedulerLoop({
    queues: { cpu: cpuDispatchQueue },
    intervalMs: cfg.SCHEDULER_TICK_MS,
  });
  console.log(`scheduler tick loop started (interval=${cfg.SCHEDULER_TICK_MS}ms)`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}, shutting down`);
    try {
      await loop.stop();
      await cpuWorker.close();
      await closeQueues();
      await lock.release();
      await closeDb();
    } catch (err) {
      console.error("error during shutdown:", err);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("worker bootstrap failed:", err);
  process.exit(1);
});
