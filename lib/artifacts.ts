import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getConfig } from "./config";

// Per-task artifact paths must be deterministic: the worker writes the file,
// then verifies it exists, then inserts the artifacts row keyed on the path.

export function cpuArtifactPath(taskId: string): string {
  return join(getConfig().ARTIFACTS_DIR, `cpu-${taskId}.txt`);
}

export function sshArtifactPath(taskId: string): string {
  return join(getConfig().ARTIFACTS_DIR, `ssh-${taskId}.txt`);
}

export function trainArtifactPath(jobId: string): string {
  return join(getConfig().ARTIFACTS_DIR, `train-${jobId}.txt`);
}

export async function writeArtifactFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
