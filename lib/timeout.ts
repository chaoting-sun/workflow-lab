// Per-kind timeouts wrap every worker handler in Promise.race. The race
// doesn't cancel the loser — `work` continues running in the background after
// a timeout. We attach a no-op catch to suppress unhandled rejections when
// the slow work eventually rejects, and we always clear the setTimeout to
// avoid keeping the event loop alive on success.

export class TimeoutError extends Error {
  // `kind` is the discriminator used to set tasks.failure_reason='timeout'.
  readonly kind = "timeout" as const;

  constructor(ms: number) {
    super(`operation timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  // Suppress any late rejection from the loser of the race.
  work.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });

  return Promise.race([work, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
