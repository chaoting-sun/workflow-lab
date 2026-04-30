import { z } from "zod";

const intMs = z.coerce.number().int().positive();
const intCount = z.coerce.number().int().nonnegative();
const rate = z.coerce.number().min(0).max(1);

const schema = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    ARTIFACTS_DIR: z.string().min(1).default("./artifacts"),

    GLOBAL_CPU_SLOTS: intCount,
    GLOBAL_SSH_SLOTS: intCount,
    GLOBAL_TRAINING_SLOTS: intCount,

    CPU_SLEEP_MIN_MS: intMs,
    CPU_SLEEP_MAX_MS: intMs,
    SSH_SLEEP_MS: intMs,
    TRAINING_SLEEP_MS: intMs,

    PIPELINES_PER_JOB: z.coerce.number().int().min(1).max(1000),
    SCHEDULER_TICK_MS: intMs,

    LEASE_TTL_MS: intMs,
    LEASE_HEARTBEAT_MS: intMs,

    CPU_TIMEOUT_MS: intMs,
    SSH_TIMEOUT_MS: intMs,
    TRAINING_TIMEOUT_MS: intMs,

    BULLMQ_LOCK_DURATION_MS: intMs,

    MAX_ATTEMPTS: z.coerce.number().int().min(1),

    SSH_BACKPRESSURE_THRESHOLD: intCount,

    CHAOS_CPU_CRASH_RATE: rate,
    CHAOS_SSH_TIMEOUT_RATE: rate,
    CHAOS_SSH_MISSING_ARTIFACT_RATE: rate,
  })
  .refine((c) => c.CPU_SLEEP_MIN_MS <= c.CPU_SLEEP_MAX_MS, {
    message: "CPU_SLEEP_MIN_MS must be <= CPU_SLEEP_MAX_MS",
    path: ["CPU_SLEEP_MIN_MS"],
  });

export type Config = z.infer<typeof schema>;

export function parseConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.errors.map((e) => {
      const field = e.path.join(".") || "<root>";
      return `  - ${field}: ${e.message}`;
    });
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}

let cached: Config | null = null;
export function getConfig(): Config {
  if (cached) return cached;
  cached = parseConfig(process.env);
  return cached;
}
