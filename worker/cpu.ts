import { access } from "node:fs/promises";
import { getConfig } from "../lib/config";
import { cpuArtifactPath, writeArtifactFile } from "../lib/artifacts";
import { maybeCrash } from "../lib/chaos";
import { sleep } from "../lib/sleep";
import { withTimeout } from "../lib/timeout";
import {
  claimTask,
  finalizeCpuSuccess,
  recordFailure,
  StaleAttemptError,
  startHeartbeat,
  type WorkerTaskMessage,
} from "../lib/worker";

function randomBetween(minMs: number, maxMs: number): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
}

export type CpuWorkFn = (taskId: string) => Promise<string>;

export interface RunCpuOptions {
  // Override CPU_TIMEOUT_MS for tests; production uses config.
  timeoutMs?: number;
}

// Crash mid-sleep (not at the boundaries) so the lease is held, the task is
// `running`, and the heartbeat is mid-renewal when the process dies — that's
// the failure mode the reaper exists to catch.
export async function defaultCpuWork(taskId: string): Promise<string> {
  const cfg = getConfig();
  const total = randomBetween(cfg.CPU_SLEEP_MIN_MS, cfg.CPU_SLEEP_MAX_MS);
  const firstHalf = Math.floor(total / 2);
  await sleep(firstHalf);
  maybeCrash(cfg.CHAOS_CPU_CRASH_RATE);
  await sleep(total - firstHalf);
  const path = cpuArtifactPath(taskId);
  await writeArtifactFile(path, `cpu task ${taskId}\n`);
  return path;
}

// `doWork` is injectable so tests can swap in a fast variant without
// touching config; production uses defaultCpuWork.
//
// fs.access is the on-disk artifact verification, run BEFORE the finalize
// transaction — filesystem IO must not happen inside a DB tx.
//
// withTimeout caps doWork at CPU_TIMEOUT_MS so a wedged task can never block
// the worker indefinitely; on timeout (or any other doWork failure) we route
// through finalizeTaskFailure rather than re-throwing, so BullMQ sees a clean
// completion and the worker is immediately ready for the next message.
export async function runCpuTask(
  msg: WorkerTaskMessage,
  doWork: CpuWorkFn = defaultCpuWork,
  opts: RunCpuOptions = {},
): Promise<void> {
  const claimed = await claimTask(msg);
  if (!claimed) return;

  const timeoutMs = opts.timeoutMs ?? getConfig().CPU_TIMEOUT_MS;
  const heartbeat = startHeartbeat(msg.taskId, msg.leaseToken);
  try {
    const artifactPath = await withTimeout(doWork(claimed.taskId), timeoutMs);
    await access(artifactPath);
    await finalizeCpuSuccess(claimed, artifactPath);
  } catch (err) {
    if (err instanceof StaleAttemptError) return;
    await recordFailure(claimed, err);
  } finally {
    heartbeat.stop();
  }
}
