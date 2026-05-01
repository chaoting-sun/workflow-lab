// Manual verification for the scheduler advisory lock.
// Run with: pnpm tsx scripts/test-lock.ts
import { acquireSchedulerLock } from "../lib/advisory-lock";
import { closeDb } from "../lib/db";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const first = await acquireSchedulerLock();
  assert(first !== null, "first acquire should succeed");
  console.log("ok: first acquire succeeded");

  const second = await acquireSchedulerLock();
  assert(second === null, "second concurrent acquire should return null");
  console.log("ok: second concurrent acquire returned null");

  await first.release();
  console.log("ok: released first lock");

  const third = await acquireSchedulerLock();
  assert(third !== null, "acquire after release should succeed");
  console.log("ok: re-acquired after release");
  await third.release();

  await closeDb();
  console.log("PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
