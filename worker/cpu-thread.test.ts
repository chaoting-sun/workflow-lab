import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture every fake Worker instance so each test can grab the most recent
// one and emit message/exit events on it.
interface FakeWorkerOptions {
  workerData?: unknown;
  eval?: boolean;
}

interface FakeWorkerInstance extends EventEmitter {
  terminate: ReturnType<typeof vi.fn>;
  ctorArgs: { source: string | URL; options: FakeWorkerOptions | undefined };
}

const instances: FakeWorkerInstance[] = [];

class FakeWorker extends EventEmitter implements FakeWorkerInstance {
  terminate = vi.fn(async () => 0);
  ctorArgs: { source: string | URL; options: FakeWorkerOptions | undefined };

  constructor(source: string | URL, options?: FakeWorkerOptions) {
    super();
    this.ctorArgs = { source, options };
    instances.push(this);
  }
}

vi.mock("node:worker_threads", async () => {
  const actual = await vi.importActual<typeof import("node:worker_threads")>(
    "node:worker_threads",
  );
  return { ...actual, Worker: FakeWorker };
});

// Import after vi.mock hoist so cpu.ts sees the fake Worker class.
const { defaultCpuWork } = await import("./cpu");

function lastInstance(): FakeWorkerInstance {
  const w = instances.at(-1);
  if (!w) throw new Error("no FakeWorker instance was constructed");
  return w;
}

beforeEach(() => {
  instances.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("defaultCpuWork", () => {
  it("spawns a worker_thread bootstrap that imports cpu-thread.ts and forwards the taskId via workerData", async () => {
    const promise = defaultCpuWork("task-spawn");
    // Resolve so the test cleans up.
    queueMicrotask(() => {
      lastInstance().emit("message", { ok: true, path: "/tmp/cpu-task-spawn.txt" });
    });
    await promise;

    const inst = lastInstance();
    // Bootstrap is an eval-mode source string (tsx loader doesn't propagate
    // to worker_threads automatically — see cpu.ts for the why).
    expect(typeof inst.ctorArgs.source).toBe("string");
    expect(inst.ctorArgs.source as string).toContain("worker/cpu-thread.ts");
    expect(inst.ctorArgs.source as string).toContain("tsx/esm/api");
    expect(inst.ctorArgs.options?.eval).toBe(true);
    expect(inst.ctorArgs.options?.workerData).toEqual({ taskId: "task-spawn" });
  });

  it("resolves with the artifact path posted by the worker_thread", async () => {
    const promise = defaultCpuWork("task-ok");
    queueMicrotask(() => {
      lastInstance().emit("message", {
        ok: true,
        path: "/tmp/cpu-task-ok.txt",
      });
    });
    await expect(promise).resolves.toBe("/tmp/cpu-task-ok.txt");
  });

  it("rejects with the error string the worker_thread reports on failure", async () => {
    const promise = defaultCpuWork("task-fail");
    queueMicrotask(() => {
      lastInstance().emit("message", { ok: false, error: "fs.access ENOENT" });
    });
    await expect(promise).rejects.toThrow("fs.access ENOENT");
  });

  it("calls worker.terminate() when the AbortSignal aborts (so withTimeout can kill the thread)", async () => {
    const ac = new AbortController();
    const promise = defaultCpuWork("task-abort", ac.signal);
    queueMicrotask(() => ac.abort());
    await expect(promise).rejects.toThrow();

    expect(lastInstance().terminate).toHaveBeenCalledTimes(1);
  });

  it("mirrors a non-zero thread exit (with no prior message) by calling process.exit(1) (preserves SPEC §9.2)", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => undefined) as never);

    const promise = defaultCpuWork("task-crash");
    // Capture the rejection so vitest doesn't see an unhandled rejection
    // when the (mocked) process.exit doesn't actually terminate the runtime.
    promise.catch(() => {});
    queueMicrotask(() => lastInstance().emit("exit", 1));

    // Yield once so the exit listener runs.
    await new Promise((r) => setImmediate(r));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
