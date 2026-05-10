// Pins the documented runtime defaults shipped in .env.example.
//
// These values are the public contract for new contributors and the baseline
// the SPEC §9.* verification scenarios assume. Drift between .env.example and
// the deployed pm2 layout has bitten us before (replan-log 2026-05-06):
// when GLOBAL_*_SLOTS exceeded *_WORKER_CONCURRENCY, scheduled leases expired
// in Redis before the worker picked them up. Encoding the rescaled 4×4
// defaults here catches a future regression at test time, not at run time.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const examplePath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../.env.example",
);

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

describe(".env.example defaults", () => {
  const env = readEnvFile(examplePath);

  it("ships 4×4 CPU+SSH slot pools matching the deployed pm2 layout", () => {
    expect(env.GLOBAL_CPU_SLOTS).toBe("4");
    expect(env.GLOBAL_SSH_SLOTS).toBe("4");
    expect(env.GLOBAL_TRAINING_SLOTS).toBe("4");
  });

  it("aligns *_WORKER_CONCURRENCY with each role's per-process slot share", () => {
    // Single-worker dev mode: concurrency must match GLOBAL_CPU_SLOTS so that
    // dispatched leases don't expire while waiting in Redis (replan-log 2026-05-06).
    // Under pm2 the cpu role overrides this to 1 per replica.
    expect(env.CPU_WORKER_CONCURRENCY).toBe("4");
    // 4 io replicas × 1 in-process SSH each = 4 SSH slots.
    expect(env.SSH_WORKER_CONCURRENCY).toBe("1");
    expect(env.TRAINING_WORKER_CONCURRENCY).toBe("4");
  });

  it("scales SSH_BACKPRESSURE_THRESHOLD with GLOBAL_SSH_SLOTS (2× per SPEC §3.8)", () => {
    expect(env.SSH_BACKPRESSURE_THRESHOLD).toBe("8");
  });

  it("exposes IO_WORKER_REPLICAS so pm2 io role boots 4 processes", () => {
    expect(env.IO_WORKER_REPLICAS).toBe("4");
  });
});
