// Loaded as the entrypoint of a `worker_threads` Worker spawned by
// `defaultCpuWork` in worker/cpu.ts. The bootstrap at the bottom (gated on
// `!isMainThread`) runs `runCpuWork` and posts the result back to the main
// thread. Tests import the named export directly; the bootstrap stays
// dormant when this file is loaded on the main thread.

import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { cpuArtifactPath, writeArtifactFile } from "../lib/artifacts";
import { maybeCrash } from "../lib/chaos";
import { getConfig } from "../lib/config";
import { sleep } from "../lib/sleep";

function randomBetween(minMs: number, maxMs: number): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
}

// Crash mid-sleep (not at the boundaries) so the lease is held, the task is
// `running`, and the heartbeat is mid-renewal when the process dies — that's
// the failure mode the reaper exists to catch.
export async function runCpuWork(taskId: string): Promise<string> {
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

export interface CpuThreadSuccess {
  ok: true;
  path: string;
}

export interface CpuThreadFailure {
  ok: false;
  error: string;
}

export type CpuThreadMessage = CpuThreadSuccess | CpuThreadFailure;

if (!isMainThread && parentPort) {
  const port = parentPort;
  const { taskId } = workerData as { taskId: string };
  runCpuWork(taskId)
    .then((path) => port.postMessage({ ok: true, path } satisfies CpuThreadMessage))
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      port.postMessage({ ok: false, error } satisfies CpuThreadMessage);
    });
}
