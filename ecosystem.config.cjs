// pm2 supervisor template.
//
// Layout:
//   1× scheduler   — holds the Postgres advisory lock + dispatches.
//   N× worker:cpu  — one CPU-bound BullMQ worker per process, concurrency=1.
//                    N defaults to GLOBAL_CPU_SLOTS so the deployed process
//                    count matches the global slot cap.
//   1–2× worker:io — SSH + training BullMQ workers, high in-process concurrency.
//
// CPU_WORKER_CONCURRENCY is forced to "1" inside each cpu replica so a single
// process saturates one core at most. Node's --env-file does not override env
// vars already set in the environment, so this beats the .env value.
//
// Usage:
//   pnpm supervisor:start    # boots the whole stack under pm2
//   pnpm supervisor:stop
//   pnpm supervisor:logs
//
// Tunables:
//   GLOBAL_CPU_SLOTS      — number of cpu worker replicas (default 4)
//   IO_WORKER_REPLICAS    — number of io worker replicas (default 4)

const fs = require("node:fs");
const path = require("node:path");

const TSX = "./node_modules/.bin/tsx";
const ENV_FILE_ARG = "--env-file=.env";

// pm2 evaluates this file in its own process and does not honour
// `--env-file=.env`, so replica counts driven by .env (GLOBAL_CPU_SLOTS,
// IO_WORKER_REPLICAS) wouldn't be visible without an explicit read.
function readDotenv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const dotenv = readDotenv(path.join(__dirname, ".env"));

function intFromEnv(name, fallback) {
  const raw = process.env[name] ?? dotenv[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const cpuReplicas = intFromEnv("GLOBAL_CPU_SLOTS", 18);
const ioReplicas = intFromEnv("IO_WORKER_REPLICAS", 1);

const common = {
  // Anchor script + args to the repo root so `pm2 start <abs path>` works
  // regardless of the shell's cwd at launch.
  cwd: __dirname,
  exec_mode: "fork",
  interpreter: "none",
  autorestart: true,
  max_restarts: 50,
};

module.exports = {
  apps: [
    {
      ...common,
      name: "scheduler",
      script: TSX,
      args: [ENV_FILE_ARG, "scheduler/index.ts"],
      instances: 1,
    },
    {
      ...common,
      name: "worker:cpu",
      script: TSX,
      args: [ENV_FILE_ARG, "worker/index.ts"],
      instances: cpuReplicas,
      env: {
        WORKER_ROLE: "cpu",
        CPU_WORKER_CONCURRENCY: "1",
      },
    },
    {
      ...common,
      name: "worker:io",
      script: TSX,
      args: [ENV_FILE_ARG, "worker/index.ts"],
      instances: ioReplicas,
      env: {
        WORKER_ROLE: "io",
      },
    },
  ],
};
