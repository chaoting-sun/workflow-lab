import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cpuArtifactPath,
  sshArtifactPath,
  trainArtifactPath,
  writeArtifactFile,
} from "./artifacts";
import { getConfig } from "./config";

describe("artifact path helpers", () => {
  const artifactsDir = getConfig().ARTIFACTS_DIR;

  it("builds the cpu artifact path as <ARTIFACTS_DIR>/cpu-<taskId>.txt", () => {
    expect(cpuArtifactPath("abc-123")).toBe(join(artifactsDir, "cpu-abc-123.txt"));
  });

  it("builds the ssh artifact path as <ARTIFACTS_DIR>/ssh-<taskId>.txt", () => {
    expect(sshArtifactPath("abc-123")).toBe(join(artifactsDir, "ssh-abc-123.txt"));
  });

  it("builds the training artifact path as <ARTIFACTS_DIR>/train-<jobId>.txt (keyed by job, not task)", () => {
    expect(trainArtifactPath("job-9")).toBe(join(artifactsDir, "train-job-9.txt"));
  });

  it("produces distinct paths for the three kinds with the same id", () => {
    const id = "shared-id";
    const paths = new Set([
      cpuArtifactPath(id),
      sshArtifactPath(id),
      trainArtifactPath(id),
    ]);
    expect(paths.size).toBe(3);
  });
});

describe("writeArtifactFile", () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "workflow-lab-artifacts-"));
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("writes the file content at the given path", async () => {
    const path = join(tmpRoot, "plain.txt");
    await writeArtifactFile(path, "hello");
    expect(await readFile(path, "utf-8")).toBe("hello");
  });

  it("creates missing parent directories recursively", async () => {
    const path = join(tmpRoot, "deep", "nested", "dir", "file.txt");
    await writeArtifactFile(path, "x");
    const info = await stat(path);
    expect(info.isFile()).toBe(true);
  });

  it("overwrites an existing file rather than appending", async () => {
    const path = join(tmpRoot, "overwrite.txt");
    await writeArtifactFile(path, "first");
    await writeArtifactFile(path, "second");
    expect(await readFile(path, "utf-8")).toBe("second");
  });

  it("handles empty content without error", async () => {
    const path = join(tmpRoot, "empty.txt");
    await writeArtifactFile(path, "");
    expect(await readFile(path, "utf-8")).toBe("");
  });
});
