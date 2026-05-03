// Worker process entrypoint. Run with: pnpm worker.
// Boots the scheduler tick loop (guarded by the Postgres advisory lock) and
// the BullMQ Workers in a single Node process.

import { Worker, type Job } from "bullmq";
import { acquireSchedulerLock } from "../lib/advisory-lock";
import { getConfig } from "../lib/config";
import { closeDb } from "../lib/db";
import {
  closeQueues,
  cpuDispatchQueue,
  getRedisConnection,
  sshDispatchQueue,
  trainingDispatchQueue,
} from "../lib/queues";
import { runSchedulerLoop } from "../lib/scheduler";
import type { WorkerTaskMessage } from "../lib/worker";
import { runCpuTask } from "./cpu";
import { runSshTask } from "./ssh";
import { runTrainingTask } from "./training";

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

  const cpuWorker = new Worker<WorkerTaskMessage>(
    "cpu",
    async (job: Job<WorkerTaskMessage>) => {
      await runCpuTask(job.data);
    },
    {
      connection: getRedisConnection(),
      lockDuration: cfg.BULLMQ_LOCK_DURATION_MS,
      concurrency: cfg.CPU_WORKER_CONCURRENCY,
    },
  );
  cpuWorker.on("failed", (job, err) => {
    console.error(`cpu job ${job?.id} failed:`, err);
  });

  const sshWorker = new Worker<WorkerTaskMessage>(
    "ssh",
    async (job: Job<WorkerTaskMessage>) => {
      await runSshTask(job.data);
    },
    {
      connection: getRedisConnection(),
      lockDuration: cfg.BULLMQ_LOCK_DURATION_MS,
      concurrency: cfg.SSH_WORKER_CONCURRENCY,
    },
  );
  sshWorker.on("failed", (job, err) => {
    console.error(`ssh job ${job?.id} failed:`, err);
  });

  const trainingWorker = new Worker<WorkerTaskMessage>(
    "training",
    async (job: Job<WorkerTaskMessage>) => {
      await runTrainingTask(job.data);
    },
    {
      connection: getRedisConnection(),
      lockDuration: cfg.BULLMQ_LOCK_DURATION_MS,
      concurrency: cfg.TRAINING_WORKER_CONCURRENCY,
    },
  );
  trainingWorker.on("failed", (job, err) => {
    console.error(`training job ${job?.id} failed:`, err);
  });

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
      await cpuWorker.close();
      await sshWorker.close();
      await trainingWorker.close();
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
