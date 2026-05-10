import { access } from "node:fs/promises";
import { Worker as ThreadWorker } from "node:worker_threads";
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
import type { CpuThreadMessage } from "./cpu-thread";

export type CpuWorkFn = (taskId: string, signal?: AbortSignal) => Promise<string>;

export interface RunCpuOptions {
  // Override CPU_TIMEOUT_MS for tests; production uses config.
  timeoutMs?: number;
}

const CPU_THREAD_URL = new URL("./cpu-thread.ts", import.meta.url);

// Spawned via `eval: true` because tsx's ESM loader does not auto-register
// inside a worker_thread — its initialize hook is gated on isMainThread, so
// without re-registering, the thread would fail to resolve cpu-thread.ts's
// extension-less TS imports.
const CPU_THREAD_BOOTSTRAP = `
  const { register } = await import("tsx/esm/api");
  register();
  await import(${JSON.stringify(CPU_THREAD_URL.href)});
`;

// Spawns the CPU work in a `worker_threads` Worker so synchronous compute in
// the thread can never block the main thread's heartbeat or BullMQ lock
// renewal.
export async function defaultCpuWork(
  taskId: string,
  signal?: AbortSignal,
): Promise<string> {
  const thread = new ThreadWorker(CPU_THREAD_BOOTSTRAP, {
    eval: true,
    workerData: { taskId },
  });

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const onAbort = (): void => {
      void thread.terminate();
      settle(() => reject(new Error(`cpu-thread aborted (taskId=${taskId})`)));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    thread.once("message", (msg: CpuThreadMessage) => {
      if (msg.ok) settle(() => resolve(msg.path));
      else settle(() => reject(new Error(msg.error)));
    });
    thread.once("error", (err) => {
      settle(() => reject(err));
    });
    thread.once("exit", (code) => {
      if (settled) return;
      // No success/failure message and no abort before exit — this is the
      // `maybeCrash` path. Take the parent down with us so worker:watch
      // reboots and the lease reaper recovers; otherwise a chaos-crashed
      // thread would only kill the thread, not the worker process.
      if (code !== 0) {
        process.exit(1);
      }
      settle(() =>
        reject(new Error(`cpu-thread exited unexpectedly (code=${code})`)),
      );
    });
  });
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
  // The AbortController lets defaultCpuWork tear down its worker_thread when
  // withTimeout fires (or anything else throws). Aborting in `finally` makes
  // success, timeout, and StaleAttemptError paths all converge on the same
  // cleanup.
  const ac = new AbortController();
  try {
    const artifactPath = await withTimeout(
      doWork(claimed.taskId, ac.signal),
      timeoutMs,
    );
    await access(artifactPath);
    await finalizeCpuSuccess(claimed, artifactPath);
  } catch (err) {
    if (err instanceof StaleAttemptError) return;
    await recordFailure(claimed, err);
  } finally {
    ac.abort();
    heartbeat.stop();
  }
}
