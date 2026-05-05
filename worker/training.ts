import { getConfig } from "../lib/config";
import { trainArtifactPath, writeArtifactFile } from "../lib/artifacts";
import { sleep } from "../lib/sleep";
import { withTimeout } from "../lib/timeout";
import {
  claimTask,
  finalizeTrainingSuccess,
  recordFailure,
  StaleAttemptError,
  startHeartbeat,
  type WorkerTaskMessage,
} from "../lib/worker";

export type TrainingWorkFn = (jobId: string) => Promise<string>;

export interface RunTrainingOptions {
  // Override TRAINING_TIMEOUT_MS for tests; production uses config.
  timeoutMs?: number;
}

export async function defaultTrainingWork(jobId: string): Promise<string> {
  const cfg = getConfig();
  await sleep(cfg.TRAINING_SLEEP_MS);
  const path = trainArtifactPath(jobId);
  await writeArtifactFile(path, `training job ${jobId}\n`);
  return path;
}

// `doWork` is injectable so tests can swap in a fast variant without touching
// config; production uses defaultTrainingWork.
//
// Unlike CPU/SSH, training does not call fs.access nor insert an artifacts
// row — the disk file is purely for human inspection (per SPEC §9.1) and
// the barrier never inspects it.
//
// withTimeout caps doWork at TRAINING_TIMEOUT_MS; on timeout or other doWork
// failure we route through finalizeTaskFailure so the worker is immediately
// ready for the next message and the job propagates to 'failed' once
// MAX_ATTEMPTS is exhausted.
export async function runTrainingTask(
  msg: WorkerTaskMessage,
  doWork: TrainingWorkFn = defaultTrainingWork,
  opts: RunTrainingOptions = {},
): Promise<void> {
  const claimed = await claimTask(msg);
  if (!claimed) return;

  const timeoutMs = opts.timeoutMs ?? getConfig().TRAINING_TIMEOUT_MS;
  const heartbeat = startHeartbeat(msg.taskId, msg.leaseToken);
  try {
    await withTimeout(doWork(claimed.jobId), timeoutMs);
    await finalizeTrainingSuccess(claimed);
  } catch (err) {
    if (err instanceof StaleAttemptError) return;
    await recordFailure(claimed, err);
  } finally {
    heartbeat.stop();
  }
}
