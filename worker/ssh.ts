import { access } from "node:fs/promises";
import { getConfig } from "../lib/config";
import { sshArtifactPath, writeArtifactFile } from "../lib/artifacts";
import { sleep } from "../lib/sleep";
import {
  claimTask,
  finalizeSshSuccess,
  StaleAttemptError,
  startHeartbeat,
  type WorkerTaskMessage,
} from "../lib/worker";

export type SshWorkFn = (taskId: string) => Promise<string>;

export async function defaultSshWork(taskId: string): Promise<string> {
  const cfg = getConfig();
  await sleep(cfg.SSH_SLEEP_MS);
  const path = sshArtifactPath(taskId);
  await writeArtifactFile(path, `ssh task ${taskId}\n`);
  return path;
}

// `doWork` is injectable so tests can swap in a fast variant. fs.access runs
// BEFORE the finalize transaction so filesystem IO never lives inside a DB tx,
// and the artifact row is only inserted after the file is confirmed on disk.
export async function runSshTask(
  msg: WorkerTaskMessage,
  doWork: SshWorkFn = defaultSshWork,
): Promise<void> {
  const claimed = await claimTask(msg);
  if (!claimed) return;

  const heartbeat = startHeartbeat(msg.leaseId);
  try {
    const artifactPath = await doWork(claimed.taskId);
    await access(artifactPath);
    await finalizeSshSuccess(claimed, msg.leaseId, artifactPath);
  } catch (err) {
    if (err instanceof StaleAttemptError) return;
    throw err;
  } finally {
    heartbeat.stop();
  }
}
