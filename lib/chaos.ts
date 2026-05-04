// Chaos injection points for the resilience scenarios in SPEC.md. Pure
// helpers: the caller passes the rate (read from config) and an optional
// random source for deterministic tests. Each helper short-circuits on
// rate <= 0 so the production hot path pays only one comparison when
// chaos is off.

export type Random = () => number;

export interface MaybeCrashDeps {
  random?: Random;
  exit?: (code: number) => never;
}

// Hard-kills the worker process when the dice roll lands inside `rate`.
// Used by the CPU worker mid-task to simulate an unrecoverable crash; the
// lease reaper then resurrects the task on the next scheduler tick.
//
// When the roll fires, this function does not return — process.exit terminates
// the event loop synchronously after I/O queues drain.
export function maybeCrash(rate: number, deps: MaybeCrashDeps = {}): void {
  if (rate <= 0) return;
  const random = deps.random ?? Math.random;
  if (random() >= rate) return;
  const exit = deps.exit ?? process.exit;
  exit(1);
}

// SSH worker uses this to extend its sleep past SSH_TIMEOUT_MS so withTimeout
// fires.
export function maybeOversleep(rate: number, random: Random = Math.random): boolean {
  if (rate <= 0) return false;
  return random() < rate;
}

// SSH worker uses this to skip the artifact write — fs.access then throws
// and the task fails with a non-timeout error path.
export function maybeSkipArtifact(rate: number, random: Random = Math.random): boolean {
  if (rate <= 0) return false;
  return random() < rate;
}
