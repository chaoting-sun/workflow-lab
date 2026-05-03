import { describe, expect, it } from "vitest";
import { TimeoutError, withTimeout } from "./timeout";
import { sleep } from "./sleep";

describe("withTimeout", () => {
  it("resolves with the work value when work finishes before the timeout", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 100);
    expect(result).toBe("ok");
  });

  it("rejects with TimeoutError when the work outlasts the timeout", async () => {
    const slow = sleep(200).then(() => "late");
    await expect(withTimeout(slow, 20)).rejects.toBeInstanceOf(TimeoutError);
  });

  it("propagates the original rejection when work fails before the timeout", async () => {
    const failing = Promise.reject(new Error("boom"));
    await expect(withTimeout(failing, 100)).rejects.toThrow("boom");
  });

  it("does not leak unhandled rejections from a slow work that loses the race", async () => {
    let unhandled: unknown = null;
    const onRejection = (reason: unknown): void => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onRejection);
    try {
      const slow = sleep(40).then(() => Promise.reject(new Error("late-boom")));
      await expect(withTimeout(slow, 10)).rejects.toBeInstanceOf(TimeoutError);
      // Give the late rejection a chance to surface.
      await sleep(80);
      expect(unhandled).toBeNull();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

describe("TimeoutError", () => {
  it("has kind === 'timeout' so callers can branch on the failure_reason", () => {
    const err = new TimeoutError(50);
    expect(err.kind).toBe("timeout");
    expect(err).toBeInstanceOf(Error);
  });
});
