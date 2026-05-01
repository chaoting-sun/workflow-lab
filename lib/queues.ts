import { Queue } from "bullmq";
import IORedis from "ioredis";
import { getConfig } from "./config";
import type { DispatchMessage, DispatchQueue } from "./scheduler";

// One BullMQ queue per task kind. Same payload shape on all three; the kind
// is implicit in the queue. BullMQ is delivery-only — no priorities, no
// BullMQ retries (failure recovery flows through tasks.attempts + leases).

const JOB_NAME = "task";

let connection: IORedis | null = null;
let cpuQueue: Queue<DispatchMessage> | null = null;
let sshQueue: Queue<DispatchMessage> | null = null;
let trainingQueue: Queue<DispatchMessage> | null = null;

// BullMQ requires `maxRetriesPerRequest: null` on connections shared with
// Workers (blocking commands). We set it here so the same connection can be
// safely handed to future Worker instances.
export function getRedisConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(getConfig().REDIS_URL, {
      maxRetriesPerRequest: null,
    });
  }
  return connection;
}

function getCpuQueue(): Queue<DispatchMessage> {
  return (cpuQueue ??= new Queue<DispatchMessage>("cpu", {
    connection: getRedisConnection(),
  }));
}

function getSshQueue(): Queue<DispatchMessage> {
  return (sshQueue ??= new Queue<DispatchMessage>("ssh", {
    connection: getRedisConnection(),
  }));
}

function getTrainingQueue(): Queue<DispatchMessage> {
  return (trainingQueue ??= new Queue<DispatchMessage>("training", {
    connection: getRedisConnection(),
  }));
}

function adapt(getQueue: () => Queue<DispatchMessage>): DispatchQueue {
  return {
    async add(payload: DispatchMessage): Promise<void> {
      await getQueue().add(JOB_NAME, payload);
    },
  };
}

export const cpuDispatchQueue: DispatchQueue = adapt(getCpuQueue);
export const sshDispatchQueue: DispatchQueue = adapt(getSshQueue);
export const trainingDispatchQueue: DispatchQueue = adapt(getTrainingQueue);

export async function closeQueues(): Promise<void> {
  const queues = [cpuQueue, sshQueue, trainingQueue];
  cpuQueue = sshQueue = trainingQueue = null;
  for (const q of queues) {
    if (q) await q.close();
  }
  if (connection) {
    const c = connection;
    connection = null;
    c.disconnect();
  }
}
