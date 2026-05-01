import { access } from "node:fs/promises";
import { getConfig } from "../lib/config";
import { cpuArtifactPath, writeArtifactFile } from "../lib/artifacts";
import {
  claimTask,
  finalizeCpuSuccess,
  StaleAttemptError,
  type WorkerTaskMessage,
} from "../lib/worker";

function randomBetween(minMs: number, maxMs: number): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type CpuWorkFn = (taskId: string) => Promise<string>;

export async function defaultCpuWork(taskId: string): Promise<string> {
  const cfg = getConfig();
  await sleep(randomBetween(cfg.CPU_SLEEP_MIN_MS, cfg.CPU_SLEEP_MAX_MS));
  const path = cpuArtifactPath(taskId);
  await writeArtifactFile(path, `cpu task ${taskId}\n`);
  return path;
}

// `doWork` is injectable so tests can swap in a fast variant without
// touching config; production uses defaultCpuWork.
//
// fs.access is the on-disk artifact verification, run BEFORE the finalize
// transaction — filesystem IO must not happen inside a DB tx.
export async function runCpuTask(
  msg: WorkerTaskMessage,
  doWork: CpuWorkFn = defaultCpuWork,
): Promise<void> {
  const claimed = await claimTask(msg);
  if (!claimed) return;

  try {
    const artifactPath = await doWork(claimed.taskId);
    await access(artifactPath);
    await finalizeCpuSuccess(claimed, msg.leaseId, artifactPath);
  } catch (err) {
    if (err instanceof StaleAttemptError) return;
    throw err;
  }
}
