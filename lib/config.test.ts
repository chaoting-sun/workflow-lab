import { describe, it, expect } from "vitest";
import { parseConfig } from "./config";

const baseEnv = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  ARTIFACTS_DIR: "./artifacts",
  GLOBAL_CPU_SLOTS: "20",
  GLOBAL_SSH_SLOTS: "40",
  GLOBAL_TRAINING_SLOTS: "4",
  CPU_SLEEP_MIN_MS: "3000",
  CPU_SLEEP_MAX_MS: "5000",
  SSH_SLEEP_MS: "1000",
  TRAINING_SLEEP_MS: "5000",
  PIPELINES_PER_JOB: "200",
  SCHEDULER_TICK_MS: "1000",
  LEASE_TTL_MS: "30000",
  LEASE_HEARTBEAT_MS: "5000",
  CPU_TIMEOUT_MS: "15000",
  SSH_TIMEOUT_MS: "5000",
  TRAINING_TIMEOUT_MS: "60000",
  BULLMQ_LOCK_DURATION_MS: "70000",
  MAX_ATTEMPTS: "3",
  SSH_BACKPRESSURE_THRESHOLD: "80",
  CHAOS_CPU_CRASH_RATE: "0",
  CHAOS_SSH_TIMEOUT_RATE: "0",
  CHAOS_SSH_MISSING_ARTIFACT_RATE: "0",
};

describe("parseConfig", () => {
  it("parses a complete env into a typed config with coerced numbers", () => {
    const cfg = parseConfig(baseEnv);
    expect(cfg.DATABASE_URL).toBe("postgres://u:p@localhost:5432/db");
    expect(cfg.REDIS_URL).toBe("redis://localhost:6379");
    expect(cfg.GLOBAL_CPU_SLOTS).toBe(20);
    expect(cfg.PIPELINES_PER_JOB).toBe(200);
    expect(cfg.CHAOS_CPU_CRASH_RATE).toBe(0);
  });

  it("throws a readable error when DATABASE_URL is missing", () => {
    const { DATABASE_URL: _, ...env } = baseEnv;
    expect(() => parseConfig(env)).toThrow(/DATABASE_URL/);
  });

  it("throws a readable error when REDIS_URL is missing", () => {
    const { REDIS_URL: _, ...env } = baseEnv;
    expect(() => parseConfig(env)).toThrow(/REDIS_URL/);
  });

  it("rejects PIPELINES_PER_JOB = 0", () => {
    expect(() => parseConfig({ ...baseEnv, PIPELINES_PER_JOB: "0" })).toThrow(
      /PIPELINES_PER_JOB/,
    );
  });

  it("rejects PIPELINES_PER_JOB = 1001", () => {
    expect(() =>
      parseConfig({ ...baseEnv, PIPELINES_PER_JOB: "1001" }),
    ).toThrow(/PIPELINES_PER_JOB/);
  });

  it("accepts boundary values for PIPELINES_PER_JOB (1 and 1000)", () => {
    expect(parseConfig({ ...baseEnv, PIPELINES_PER_JOB: "1" }).PIPELINES_PER_JOB).toBe(1);
    expect(parseConfig({ ...baseEnv, PIPELINES_PER_JOB: "1000" }).PIPELINES_PER_JOB).toBe(1000);
  });

  it("rejects non-numeric numeric fields", () => {
    expect(() => parseConfig({ ...baseEnv, GLOBAL_CPU_SLOTS: "twenty" })).toThrow(
      /GLOBAL_CPU_SLOTS/,
    );
  });

  it("rejects chaos rates outside [0, 1]", () => {
    expect(() =>
      parseConfig({ ...baseEnv, CHAOS_CPU_CRASH_RATE: "1.5" }),
    ).toThrow(/CHAOS_CPU_CRASH_RATE/);
    expect(() =>
      parseConfig({ ...baseEnv, CHAOS_SSH_TIMEOUT_RATE: "-0.1" }),
    ).toThrow(/CHAOS_SSH_TIMEOUT_RATE/);
  });

  it("accepts chaos rates at boundaries (0 and 1)", () => {
    const cfg = parseConfig({
      ...baseEnv,
      CHAOS_CPU_CRASH_RATE: "1",
      CHAOS_SSH_TIMEOUT_RATE: "0",
      CHAOS_SSH_MISSING_ARTIFACT_RATE: "0.5",
    });
    expect(cfg.CHAOS_CPU_CRASH_RATE).toBe(1);
    expect(cfg.CHAOS_SSH_TIMEOUT_RATE).toBe(0);
    expect(cfg.CHAOS_SSH_MISSING_ARTIFACT_RATE).toBe(0.5);
  });

  it("rejects MAX_ATTEMPTS < 1", () => {
    expect(() => parseConfig({ ...baseEnv, MAX_ATTEMPTS: "0" })).toThrow(
      /MAX_ATTEMPTS/,
    );
  });

  it("rejects CPU_SLEEP_MIN_MS > CPU_SLEEP_MAX_MS", () => {
    expect(() =>
      parseConfig({
        ...baseEnv,
        CPU_SLEEP_MIN_MS: "9000",
        CPU_SLEEP_MAX_MS: "5000",
      }),
    ).toThrow(/CPU_SLEEP/);
  });

  // BullMQ's lock would expire mid-task otherwise, causing duplicate delivery.
  // The 5000ms guard band absorbs scheduler/network jitter between the timeout
  // and lock expiry.
  it("rejects BULLMQ_LOCK_DURATION_MS less than max timeout + 5000ms guard", () => {
    expect(() =>
      parseConfig({
        ...baseEnv,
        TRAINING_TIMEOUT_MS: "60000",
        BULLMQ_LOCK_DURATION_MS: "64999",
      }),
    ).toThrow(/BULLMQ_LOCK_DURATION_MS/);
  });

  it("accepts BULLMQ_LOCK_DURATION_MS exactly at max timeout + 5000ms boundary", () => {
    const cfg = parseConfig({
      ...baseEnv,
      CPU_TIMEOUT_MS: "15000",
      SSH_TIMEOUT_MS: "5000",
      TRAINING_TIMEOUT_MS: "60000",
      BULLMQ_LOCK_DURATION_MS: "65000",
    });
    expect(cfg.BULLMQ_LOCK_DURATION_MS).toBe(65000);
  });

  it("computes max timeout across all kinds, not just TRAINING", () => {
    expect(() =>
      parseConfig({
        ...baseEnv,
        CPU_TIMEOUT_MS: "120000",
        SSH_TIMEOUT_MS: "5000",
        TRAINING_TIMEOUT_MS: "60000",
        BULLMQ_LOCK_DURATION_MS: "70000",
      }),
    ).toThrow(/BULLMQ_LOCK_DURATION_MS/);
  });
});
