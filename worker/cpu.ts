import { access } from "node:fs/promises";
import { getConfig } from "../lib/config";
import { withTimeout } from "../lib/timeout";
import {
  claimTask,
  finalizeCpuSuccess,
  recordFailure,
  StaleAttemptError,
  startHeartbeat,
  type WorkerTaskMessage,
} from "../lib/worker";
import { runCpuWork } from "./cpu-thread";

export type CpuWorkFn = (taskId: string) => Promise<string>;

export interface RunCpuOptions {
  // Override CPU_TIMEOUT_MS for tests; production uses config.
  timeoutMs?: number;
}

export async function defaultCpuWork(taskId: string): Promise<string> {
  return runCpuWork(taskId);
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
