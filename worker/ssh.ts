import { access } from "node:fs/promises";
import { getConfig } from "../lib/config";
import { sshArtifactPath, writeArtifactFile } from "../lib/artifacts";
import { maybeOversleep, maybeSkipArtifact } from "../lib/chaos";
import { sleep } from "../lib/sleep";
import { withTimeout } from "../lib/timeout";
import {
  claimTask,
  finalizeSshSuccess,
  recordFailure,
  StaleAttemptError,
  startHeartbeat,
  type WorkerTaskMessage,
} from "../lib/worker";

export type SshWorkFn = (taskId: string) => Promise<string>;

export interface RunSshOptions {
  // Override SSH_TIMEOUT_MS for tests; production uses config.
  timeoutMs?: number;
}

// Buffer past SSH_TIMEOUT_MS used by the oversleep chaos hook to make sure
// withTimeout actually fires in the face of scheduler / setTimeout jitter.
const CHAOS_OVERSLEEP_BUFFER_MS = 1000;

export async function defaultSshWork(taskId: string): Promise<string> {
  const cfg = getConfig();
  const willOversleep = maybeOversleep(cfg.CHAOS_SSH_TIMEOUT_RATE);
  const willSkipArtifact = maybeSkipArtifact(cfg.CHAOS_SSH_MISSING_ARTIFACT_RATE);
  const sleepMs = willOversleep
    ? cfg.SSH_TIMEOUT_MS + CHAOS_OVERSLEEP_BUFFER_MS
    : cfg.SSH_SLEEP_MS;
  await sleep(sleepMs);
  const path = sshArtifactPath(taskId);
  if (!willSkipArtifact) {
    await writeArtifactFile(path, `ssh task ${taskId}\n`);
  }
  return path;
}

// `doWork` is injectable so tests can swap in a fast variant. fs.access runs
// BEFORE the finalize transaction so filesystem IO never lives inside a DB tx,
// and the artifact row is only inserted after the file is confirmed on disk.
//
// withTimeout caps doWork at SSH_TIMEOUT_MS; on timeout or any other doWork
// failure we route through finalizeTaskFailure so the worker is immediately
// ready for the next message and the task transitions to retry-or-fail
// instead of leaving BullMQ to retry implicitly.
export async function runSshTask(
  msg: WorkerTaskMessage,
  doWork: SshWorkFn = defaultSshWork,
  opts: RunSshOptions = {},
): Promise<void> {
  const claimed = await claimTask(msg);
  if (!claimed) return;

  const timeoutMs = opts.timeoutMs ?? getConfig().SSH_TIMEOUT_MS;
  const heartbeat = startHeartbeat(msg.taskId, msg.leaseToken);
  try {
    const artifactPath = await withTimeout(doWork(claimed.taskId), timeoutMs);
    await access(artifactPath);
    await finalizeSshSuccess(claimed, artifactPath);
  } catch (err) {
    if (err instanceof StaleAttemptError) return;
    await recordFailure(claimed, err);
  } finally {
    heartbeat.stop();
  }
}
