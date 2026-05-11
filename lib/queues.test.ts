import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We mock bullmq + ioredis so we can assert wiring (queue names, payload
// routing, connection options) without standing up a real Redis. Integration
// against a live BullMQ wire is covered separately in tasks/todo.md T30.

interface CapturedQueue {
  name: string;
  options: unknown;
  added: { jobName: string; payload: unknown }[];
  close: ReturnType<typeof vi.fn>;
}

interface CapturedRedis {
  url: string;
  options: unknown;
  disconnect: ReturnType<typeof vi.fn>;
}

const queues: CapturedQueue[] = [];
const redisInstances: CapturedRedis[] = [];

class FakeQueue {
  name: string;
  options: unknown;
  added: { jobName: string; payload: unknown }[] = [];
  close = vi.fn(async () => {});

  constructor(name: string, options: unknown) {
    this.name = name;
    this.options = options;
    queues.push(this);
  }

  async add(jobName: string, payload: unknown): Promise<void> {
    this.added.push({ jobName, payload });
  }
}

class FakeRedis {
  url: string;
  options: unknown;
  disconnect = vi.fn();

  constructor(url: string, options: unknown) {
    this.url = url;
    this.options = options;
    redisInstances.push(this);
  }
}

vi.mock("bullmq", () => ({ Queue: FakeQueue }));
vi.mock("ioredis", () => ({ default: FakeRedis }));

// Import after vi.mock hoist so queues.ts picks up the fakes.
const {
  cpuDispatchQueue,
  sshDispatchQueue,
  trainingDispatchQueue,
  getRedisConnection,
  closeQueues,
} = await import("./queues");
const { getConfig } = await import("./config");

beforeEach(() => {
  queues.length = 0;
  redisInstances.length = 0;
});

afterEach(async () => {
  await closeQueues();
});

describe("getRedisConnection", () => {
  it("constructs an ioredis client with REDIS_URL and maxRetriesPerRequest: null", () => {
    const conn = getRedisConnection();
    expect(redisInstances).toHaveLength(1);
    expect(redisInstances[0].url).toBe(getConfig().REDIS_URL);
    // maxRetriesPerRequest: null is required for connections shared with
    // BullMQ Workers (blocking commands). Pin it.
    expect(redisInstances[0].options).toEqual({ maxRetriesPerRequest: null });
    expect(conn).toBe(redisInstances[0]);
  });

  it("returns the same instance on repeat calls (singleton)", () => {
    const a = getRedisConnection();
    const b = getRedisConnection();
    expect(a).toBe(b);
    expect(redisInstances).toHaveLength(1);
  });

  it("constructs a fresh connection after closeQueues()", async () => {
    const first = getRedisConnection();
    await closeQueues();
    const second = getRedisConnection();
    expect(second).not.toBe(first);
    expect(redisInstances).toHaveLength(2);
  });
});

describe("dispatch queues", () => {
  it.each([
    ["cpu", cpuDispatchQueue],
    ["ssh", sshDispatchQueue],
    ["training", trainingDispatchQueue],
  ] as const)("%s queue is named '%s' and uses the shared connection", async (expectedName, queue) => {
    await queue.add({ taskId: `t-${expectedName}`, leaseToken: "lt", attempt: 1 } as never);
    const captured = queues.find((q) => q.name === expectedName);
    expect(captured, `expected queue named ${expectedName}`).toBeTruthy();
    expect((captured!.options as { connection: unknown }).connection).toBe(
      redisInstances[0],
    );
  });

  it.each([
    ["cpu", cpuDispatchQueue],
    ["ssh", sshDispatchQueue],
    ["training", trainingDispatchQueue],
  ] as const)("%s queue forwards add(payload) as a 'task' job", async (name, queue) => {
    const payload = { taskId: `t-${name}`, leaseToken: "lt", attempt: 1 };
    await queue.add(payload as never);
    const captured = queues.find((q) => q.name === name);
    expect(captured!.added).toEqual([{ jobName: "task", payload }]);
  });

  it("lazily constructs each queue on first add()", async () => {
    expect(queues).toHaveLength(0);
    await cpuDispatchQueue.add({ taskId: "x", leaseToken: "lt", attempt: 1 } as never);
    expect(queues.map((q) => q.name)).toEqual(["cpu"]);
    await sshDispatchQueue.add({ taskId: "y", leaseToken: "lt", attempt: 1 } as never);
    expect(queues.map((q) => q.name)).toEqual(["cpu", "ssh"]);
  });

  it("reuses an already-constructed queue across multiple add() calls", async () => {
    await cpuDispatchQueue.add({ taskId: "1", leaseToken: "lt", attempt: 1 } as never);
    await cpuDispatchQueue.add({ taskId: "2", leaseToken: "lt", attempt: 1 } as never);
    const cpu = queues.filter((q) => q.name === "cpu");
    expect(cpu).toHaveLength(1);
    expect(cpu[0].added.map((a) => (a.payload as { taskId: string }).taskId)).toEqual([
      "1",
      "2",
    ]);
  });
});

describe("closeQueues", () => {
  it("closes every constructed queue and disconnects the shared connection", async () => {
    await cpuDispatchQueue.add({ taskId: "1", leaseToken: "lt", attempt: 1 } as never);
    await sshDispatchQueue.add({ taskId: "2", leaseToken: "lt", attempt: 1 } as never);
    const conn = redisInstances[0];
    const cpu = queues.find((q) => q.name === "cpu")!;
    const ssh = queues.find((q) => q.name === "ssh")!;

    await closeQueues();

    expect(cpu.close).toHaveBeenCalledOnce();
    expect(ssh.close).toHaveBeenCalledOnce();
    expect(conn.disconnect).toHaveBeenCalledOnce();
  });

  it("is a no-op when no queues or connection have been created", async () => {
    await expect(closeQueues()).resolves.toBeUndefined();
    expect(queues).toHaveLength(0);
    expect(redisInstances).toHaveLength(0);
  });

  it("does not double-close on repeated calls", async () => {
    await cpuDispatchQueue.add({ taskId: "1", leaseToken: "lt", attempt: 1 } as never);
    const cpu = queues.find((q) => q.name === "cpu")!;
    const conn = redisInstances[0];

    await closeQueues();
    await closeQueues();

    expect(cpu.close).toHaveBeenCalledOnce();
    expect(conn.disconnect).toHaveBeenCalledOnce();
  });
});
