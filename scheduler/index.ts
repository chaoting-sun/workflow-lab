// Scheduler process entrypoint. Run with: pnpm scheduler.
// Holds the single-instance Postgres advisory lock and runs the dispatch
// tick loop. Workers (cpu/io) run as separate processes via worker/index.ts.

import { acquireSchedulerLock } from "../lib/advisory-lock";
import { getConfig } from "../lib/config";
import { closeDb } from "../lib/db";
import {
  closeQueues,
  cpuDispatchQueue,
  sshDispatchQueue,
  trainingDispatchQueue,
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

  const loop = runSchedulerLoop({
    queues: {
      cpu: cpuDispatchQueue,
      ssh: sshDispatchQueue,
      training: trainingDispatchQueue,
    },
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
  console.error("scheduler bootstrap failed:", err);
  process.exit(1);
});
