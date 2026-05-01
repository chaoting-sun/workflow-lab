import { afterAll, describe, expect, it } from "vitest";
import { acquireSchedulerLock } from "./advisory-lock";
import { closeDb } from "./db";

afterAll(async () => {
  await closeDb();
});

describe("acquireSchedulerLock", () => {
  it("returns a handle on first acquire and null on a second concurrent acquire", async () => {
    const first = await acquireSchedulerLock();
    expect(first).not.toBeNull();

    try {
      const second = await acquireSchedulerLock();
      expect(second).toBeNull();
    } finally {
      await first!.release();
    }
  });

  it("can be re-acquired after the first holder releases", async () => {
    const first = await acquireSchedulerLock();
    expect(first).not.toBeNull();
    await first!.release();

    const second = await acquireSchedulerLock();
    expect(second).not.toBeNull();
    await second!.release();
  });

  it("release() is idempotent — calling it twice does not throw", async () => {
    const handle = await acquireSchedulerLock();
    expect(handle).not.toBeNull();
    await handle!.release();
    await expect(handle!.release()).resolves.toBeUndefined();
  });
});
