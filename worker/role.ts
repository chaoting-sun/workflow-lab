// Maps the WORKER_ROLE env var onto the set of task kinds a single worker
// process should handle. Splitting cpu vs. io lets the supervisor scale CPU
// workers (one per core) independently from the lighter io workers.

export type WorkerRole = "cpu" | "io";
export type TaskKind = "cpu" | "ssh" | "training";

export function parseWorkerRole(raw: string | undefined): WorkerRole {
  if (raw === "cpu" || raw === "io") return raw;
  throw new Error(
    `WORKER_ROLE must be "cpu" or "io" (got ${
      raw === undefined ? "undefined" : JSON.stringify(raw)
    })`,
  );
}

export function kindsForRole(role: WorkerRole): TaskKind[] {
  return role === "cpu" ? ["cpu"] : ["ssh", "training"];
}
