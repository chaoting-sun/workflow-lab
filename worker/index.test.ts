import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeQueues, getRedisConnection } from "../lib/queues";

// The worker entrypoint calls main() at module load and orchestrates BullMQ
// Worker construction + SIGTERM shutdown. We exercise it as a child process
// because there is no exported main() to call directly.

const ENTRY = resolve(__dirname, "index.ts");
const TSX = resolve(__dirname, "..", "node_modules", ".bin", "tsx");

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

async function runEntry(
  env: Record<string, string | undefined>,
  opts: { sigtermAfterMs?: number; readyMarker?: RegExp; timeoutMs?: number } = {},
): Promise<SpawnResult> {
  const child = spawn(TSX, [ENTRY], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutStream = child.stdout as Readable;
  const stderrStream = child.stderr as Readable;

  let stdout = "";
  let stderr = "";
  stdoutStream.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  stderrStream.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  if (opts.sigtermAfterMs !== undefined) {
    if (opts.readyMarker) {
      // Wait until the boot log appears before signalling — otherwise the
      // signal may arrive before the SIGTERM handler is registered.
      await new Promise<void>((res, rej) => {
        const t = setTimeout(
          () => rej(new Error(`readyMarker not seen in stdout:\n${stdout}\n---stderr---\n${stderr}`)),
          opts.timeoutMs ?? 15000,
        );
        const check = (): void => {
          if (opts.readyMarker!.test(stdout)) {
            clearTimeout(t);
            res();
          }
        };
        stdoutStream.on("data", check);
        check();
      });
    } else {
      await new Promise((r) => setTimeout(r, opts.sigtermAfterMs));
    }
    child.kill("SIGTERM");
  }

  return new Promise<SpawnResult>((res, rej) => {
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      rej(new Error(`worker entry did not exit within ${opts.timeoutMs ?? 15000}ms`));
    }, opts.timeoutMs ?? 15000);
    child.on("exit", (code, signal) => {
      clearTimeout(killTimer);
      res({ code, signal, stdout, stderr });
    });
  });
}

afterEach(async () => {
  // Close any Redis client opened in this test process so the file's
  // afterAll can settle cleanly. The child processes own their own clients.
  await closeQueues();
});

describe("worker entrypoint — argument validation", () => {
  it("exits non-zero when WORKER_ROLE is missing", async () => {
    const res = await runEntry({ WORKER_ROLE: undefined }, { timeoutMs: 10000 });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/WORKER_ROLE/);
  }, 15000);

  it("exits non-zero when WORKER_ROLE is unknown", async () => {
    const res = await runEntry(
      { WORKER_ROLE: "scheduler" },
      { timeoutMs: 10000 },
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/WORKER_ROLE/);
  }, 15000);
});

describe("worker entrypoint — clean shutdown", () => {
  it("starts as role=cpu and exits with code 0 on SIGTERM", async () => {
    // Touch a Redis connection here so the test will skip if Redis is not
    // up locally, rather than failing the whole suite with a misleading
    // timeout from inside the child.
    try {
      const conn = getRedisConnection();
      await conn.ping();
    } catch {
      return; // Redis not available — happy-path entry test is skipped.
    }

    const res = await runEntry(
      { WORKER_ROLE: "cpu" },
      {
        sigtermAfterMs: 0,
        readyMarker: /worker role=cpu kinds=cpu/,
        timeoutMs: 20000,
      },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/received SIGTERM, shutting down/);
  }, 25000);

  it("starts as role=io with kinds=ssh,training and exits 0 on SIGTERM", async () => {
    try {
      const conn = getRedisConnection();
      await conn.ping();
    } catch {
      return;
    }

    const res = await runEntry(
      { WORKER_ROLE: "io" },
      {
        sigtermAfterMs: 0,
        readyMarker: /worker role=io kinds=ssh,training/,
        timeoutMs: 20000,
      },
    );
    expect(res.code).toBe(0);
  }, 25000);
});
