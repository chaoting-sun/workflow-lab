import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireSchedulerLock, type SchedulerLockHandle } from "../lib/advisory-lock";
import { closeDb } from "../lib/db";
import { closeQueues, getRedisConnection } from "../lib/queues";
import { ensureSchema } from "../lib/test-helpers";

// The scheduler entrypoint guards itself with a Postgres advisory lock so
// only one instance can run the dispatch loop. Two behaviours to verify:
//   1. Duplicate-instance refusal: a second scheduler exits non-zero with
//      the documented message when the lock is already held.
//   2. Clean shutdown: SIGTERM unwinds the loop, releases the lock, and
//      exits with code 0.
//
// This test file is environment-aware: if a long-running scheduler (e.g. a
// pm2 supervisor) already holds the lock, the duplicate-instance check
// still runs against that holder, and the happy-path SIGTERM test is
// skipped at runtime rather than trying to evict the external holder.

const ENTRY = resolve(__dirname, "index.ts");
const TSX = resolve(__dirname, "..", "node_modules", ".bin", "tsx");

let externalHolderPresent = false;

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

async function runEntry(
  opts: { sigtermAfterMs?: number; readyMarker?: RegExp; timeoutMs?: number } = {},
): Promise<SpawnResult> {
  const child = spawn(TSX, [ENTRY], {
    env: { ...process.env },
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
      rej(new Error(`scheduler entry did not exit within ${opts.timeoutMs ?? 15000}ms`));
    }, opts.timeoutMs ?? 15000);
    child.on("exit", (code, signal) => {
      clearTimeout(killTimer);
      res({ code, signal, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  await ensureSchema();
  // Probe: if we can take the lock here, the env is idle. If not, an
  // external scheduler (pm2 / docker / a stray dev process) owns it, and
  // we work around it instead of fighting it.
  const probe = await acquireSchedulerLock();
  if (probe) {
    externalHolderPresent = false;
    await probe.release();
  } else {
    externalHolderPresent = true;
  }
});

afterAll(async () => {
  await closeQueues();
  await closeDb();
});

describe("scheduler entrypoint — duplicate-instance guard", () => {
  it("exits non-zero with 'advisory lock not acquired' when another holder owns the lock", async () => {
    let testHeld: SchedulerLockHandle | null = null;
    if (!externalHolderPresent) {
      // No external holder — take the lock ourselves so the spawned entry
      // sees a competing holder.
      testHeld = await acquireSchedulerLock();
      if (!testHeld) {
        throw new Error("setup failure: probe said lock was free but we cannot acquire it");
      }
    }

    try {
      const res = await runEntry({ timeoutMs: 15000 });
      expect(res.code).not.toBe(0);
      expect(res.stderr).toMatch(/advisory lock not acquired/);
    } finally {
      if (testHeld) await testHeld.release();
    }
  }, 20000);
});

describe("scheduler entrypoint — clean shutdown", () => {
  it("acquires the lock, starts the tick loop, and exits 0 on SIGTERM", async () => {
    if (externalHolderPresent) {
      // Skipping: an external scheduler owns the lock. Evicting it would
      // disrupt the user's running supervisor. The duplicate-instance test
      // above already exercises the failure branch; the happy-path branch
      // is left to integration coverage in an idle env.
      return;
    }

    try {
      const conn = getRedisConnection();
      await conn.ping();
    } catch {
      return; // Redis not reachable — skip happy-path.
    }

    const res = await runEntry({
      sigtermAfterMs: 0,
      readyMarker: /scheduler tick loop started/,
      timeoutMs: 20000,
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/scheduler lock acquired/);
    expect(res.stdout).toMatch(/received SIGTERM, shutting down/);
  }, 25000);
});
