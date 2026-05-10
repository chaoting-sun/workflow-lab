// Worker process entrypoint. Run with: pnpm worker:cpu | pnpm worker:io.
// Boots the BullMQ Workers for the kinds selected by WORKER_ROLE.
// Scheduler tick loop + advisory lock live in `scheduler/index.ts`.

import { Worker, type Job } from "bullmq";
import { getConfig } from "../lib/config";
import { closeDb } from "../lib/db";
import { closeQueues, getRedisConnection } from "../lib/queues";
import type { WorkerTaskMessage } from "../lib/worker";
import { runCpuTask } from "./cpu";
import { kindsForRole, parseWorkerRole, type TaskKind } from "./role";
import { runSshTask } from "./ssh";
import { runTrainingTask } from "./training";

function buildWorker(kind: TaskKind): Worker<WorkerTaskMessage> {
  const cfg = getConfig();
  let handler: (msg: WorkerTaskMessage) => Promise<void>;
  let concurrency: number;
  switch (kind) {
    case "cpu":
      handler = runCpuTask;
      concurrency = cfg.CPU_WORKER_CONCURRENCY;
      break;
    case "ssh":
      handler = runSshTask;
      concurrency = cfg.SSH_WORKER_CONCURRENCY;
      break;
    case "training":
      handler = runTrainingTask;
      concurrency = cfg.TRAINING_WORKER_CONCURRENCY;
      break;
  }
  const worker = new Worker<WorkerTaskMessage>(
    kind,
    async (job: Job<WorkerTaskMessage>) => {
      await handler(job.data);
    },
    {
      connection: getRedisConnection(),
      lockDuration: cfg.BULLMQ_LOCK_DURATION_MS,
      concurrency,
    },
  );
  worker.on("failed", (job, err) => {
    console.error(`${kind} job ${job?.id} failed:`, err);
  });
  return worker;
}

async function main(): Promise<void> {
  const role = parseWorkerRole(process.env.WORKER_ROLE);
  const kinds = kindsForRole(role);
  console.log(`worker role=${role} kinds=${kinds.join(",")}`);

  const workers = kinds.map(buildWorker);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}, shutting down`);
    try {
      for (const w of workers) await w.close();
      await closeQueues();
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
