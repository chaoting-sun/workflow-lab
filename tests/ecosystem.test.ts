// Shape tests for ecosystem.config.cjs (the pm2 supervisor template).
//
// pm2 itself is not exercised here — these tests just import the config file
// (which is plain CJS) and assert it produces the right declarative shape
// for different env inputs. The point is to catch silent regressions in
// replica counts or env wiring, not to validate pm2 runtime behaviour.

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requireCJS = createRequire(import.meta.url);
const configPath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../ecosystem.config.cjs",
);

interface PmApp {
  name: string;
  script: string;
  args: string[];
  instances: number;
  exec_mode: string;
  autorestart: boolean;
  interpreter?: string;
  env?: Record<string, string>;
}

interface PmConfig {
  apps: PmApp[];
}

function loadConfig(env: Record<string, string | undefined>): PmConfig {
  // Save & restore the keys we touch so tests don't leak env across cases.
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    delete requireCJS.cache[configPath];
    return requireCJS(configPath) as PmConfig;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("ecosystem.config.cjs", () => {
  it("declares the three apps in supervisor order", () => {
    const cfg = loadConfig({ GLOBAL_CPU_SLOTS: "18" });
    expect(cfg.apps.map((a) => a.name)).toEqual([
      "scheduler",
      "worker:cpu",
      "worker:io",
    ]);
  });

  it("runs the scheduler as a single instance", () => {
    const cfg = loadConfig({ GLOBAL_CPU_SLOTS: "18" });
    const scheduler = cfg.apps.find((a) => a.name === "scheduler")!;
    expect(scheduler.instances).toBe(1);
    expect(scheduler.exec_mode).toBe("fork");
    expect(scheduler.args).toContain("scheduler/index.ts");
  });

  it("scales worker:cpu replicas from GLOBAL_CPU_SLOTS", () => {
    const cfg = loadConfig({ GLOBAL_CPU_SLOTS: "12" });
    const cpu = cfg.apps.find((a) => a.name === "worker:cpu")!;
    expect(cpu.instances).toBe(12);
  });

  it("forces CPU_WORKER_CONCURRENCY=1 on each cpu replica (one task per process)", () => {
    const cfg = loadConfig({ GLOBAL_CPU_SLOTS: "18" });
    const cpu = cfg.apps.find((a) => a.name === "worker:cpu")!;
    expect(cpu.env?.WORKER_ROLE).toBe("cpu");
    expect(cpu.env?.CPU_WORKER_CONCURRENCY).toBe("1");
    expect(cpu.args).toContain("worker/index.ts");
  });

  it("falls back to IO_WORKER_REPLICAS from .env when process.env is unset", () => {
    const cfg = loadConfig({ IO_WORKER_REPLICAS: undefined });
    const io = cfg.apps.find((a) => a.name === "worker:io")!;
    // Repo's .env sets IO_WORKER_REPLICAS=4 — that should propagate through.
    expect(io.instances).toBe(4);
    expect(io.env?.WORKER_ROLE).toBe("io");
    expect(io.args).toContain("worker/index.ts");
  });

  it("worker:io scales up to IO_WORKER_REPLICAS when set", () => {
    const cfg = loadConfig({ IO_WORKER_REPLICAS: "2" });
    const io = cfg.apps.find((a) => a.name === "worker:io")!;
    expect(io.instances).toBe(2);
  });

  it("falls back to GLOBAL_CPU_SLOTS from .env when process.env is unset", () => {
    const cfg = loadConfig({ GLOBAL_CPU_SLOTS: undefined });
    const cpu = cfg.apps.find((a) => a.name === "worker:cpu")!;
    // Repo's .env sets GLOBAL_CPU_SLOTS=4 — that should propagate through.
    expect(cpu.instances).toBe(4);
  });

  it("invokes tsx with --env-file=.env so workers see the project env", () => {
    const cfg = loadConfig({ GLOBAL_CPU_SLOTS: "1" });
    for (const app of cfg.apps) {
      expect(app.script).toMatch(/tsx$/);
      expect(app.args).toContain("--env-file=.env");
      expect(app.interpreter).toBe("none");
      expect(app.autorestart).toBe(true);
    }
  });
});
