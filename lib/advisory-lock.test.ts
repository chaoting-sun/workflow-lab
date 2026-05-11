import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireSchedulerLock } from "./advisory-lock";
import { closeDb } from "./db";

// These tests need the scheduler advisory lock to be free at start. If a
// supervised scheduler process (pm2 / docker / a dev terminal) already
// owns it, we cannot evict it safely from a unit test — skip at runtime
// instead of failing the suite.
let externalHolderPresent = false;

beforeAll(async () => {
  const probe = await acquireSchedulerLock();
  if (probe) {
    await probe.release();
  } else {
    externalHolderPresent = true;
  }
});

afterAll(async () => {
  await closeDb();
});

describe("acquireSchedulerLock", () => {
  it("returns a handle on first acquire and null on a second concurrent acquire", async () => {
    if (externalHolderPresent) return;
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
    if (externalHolderPresent) return;
    const first = await acquireSchedulerLock();
    expect(first).not.toBeNull();
    await first!.release();

    const second = await acquireSchedulerLock();
    expect(second).not.toBeNull();
    await second!.release();
  });

  it("release() is idempotent — calling it twice does not throw", async () => {
    if (externalHolderPresent) return;
    const handle = await acquireSchedulerLock();
    expect(handle).not.toBeNull();
    await handle!.release();
    await expect(handle!.release()).resolves.toBeUndefined();
  });
});
