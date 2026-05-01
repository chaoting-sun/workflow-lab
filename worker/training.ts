import { getConfig } from "../lib/config";
import { trainArtifactPath, writeArtifactFile } from "../lib/artifacts";
import { sleep } from "../lib/sleep";
import {
  claimTask,
  finalizeTrainingSuccess,
  StaleAttemptError,
  type WorkerTaskMessage,
} from "../lib/worker";

export type TrainingWorkFn = (jobId: string) => Promise<string>;

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
export async function runTrainingTask(
  msg: WorkerTaskMessage,
  doWork: TrainingWorkFn = defaultTrainingWork,
): Promise<void> {
  const claimed = await claimTask(msg);
  if (!claimed) return;

  try {
    await doWork(claimed.jobId);
    await finalizeTrainingSuccess(claimed, msg.leaseId);
  } catch (err) {
    if (err instanceof StaleAttemptError) return;
    throw err;
  }
}
