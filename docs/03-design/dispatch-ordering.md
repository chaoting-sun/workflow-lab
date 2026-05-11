# Dispatch Ordering and the Role of the Queue

Companion to `queue-architecture-tradeoffs.md`. That doc compares architectural
options. This one zooms in on a single question that comes up when reading the
scheduler for the first time:

> Why does the scheduler reserve a lease *before* publishing to BullMQ, instead
> of letting the worker create the lease when it claims the message? The latter
> looks simpler — what is the extra step buying us?

The short answer is: **fairness needs a live, globally-consistent view of "who
is currently using how many slots". That view only stays correct if every
dispatch decision is committed to the DB at the moment it is made — not later,
when a worker happens to claim the message.**

This doc walks through the comparison concretely, then draws out a second
observation: because the scheduler only ever reserves "just enough" tasks to
fill free slots, BullMQ is reduced to a transport conduit. Buffering, ordering,
and policy all live in Postgres.

---

## Two execution orders, side by side

### The general approach: claim-time lease

Most off-the-shelf job systems (Sidekiq, Celery, raw BullMQ, SQS consumers)
look like this:

```
1. API / scheduler:  enqueue(task)            → BullMQ
2. Worker:           pop()                    ← BullMQ
3. Worker:           write lease to DB        → Postgres
4. Worker:           run task
5. Worker:           release lease, ack       → Postgres + BullMQ
```

The DB knows nothing about a task being "in flight" until step 3. Between
steps 1 and 3, the task lives only in the broker.

This works perfectly when ordering policy is **FIFO or static priority** —
both can be evaluated at enqueue time and never change.

### This project: reserve-time lease

```
1. API:              insert task as 'pending'                → Postgres
2. Scheduler tick:   count active leases per user            ← Postgres
3. Scheduler tick:   pick the task that best satisfies
                     fairness ordering (one row at a time)   ← Postgres
4. Scheduler tick:   UPDATE task SET status='queued',
                                     lease_token=...,
                                     lease_expires_at=...    → Postgres  ← lease created HERE
5. Scheduler tick:   bullmq.add({ taskId, leaseToken })      → BullMQ
6. Worker:           pop()                                   ← BullMQ
7. Worker:           atomic claim using leaseToken           → Postgres
8. Worker:           heartbeat, run, finalize                → Postgres
```

The lease is committed at step 4 — *before* the message exists in BullMQ, and
long before any worker touches it.

---

## Why the order matters: fairness needs live counts

The fairness ordering in `reserveOneTask` (`lib/scheduler.ts`) looks like this
in plain language:

> Among all `pending` tasks of this kind, prefer the one whose **user** currently
> has the fewest active leases. Break ties by which **job** has fewest active
> leases, then by oldest job, then by oldest task.

The first two sort keys are not "how many tasks has this user ever submitted"
or "how many tasks has this user finished". They are **how many slots is this
user occupying right now**.

That number changes every time the scheduler hands a task out. Concretely:

- 4 CPU slots, all free
- User A has 100 pending tasks, user B has 1 pending task
- Fair outcome: A gets 3 slots, B gets 1 (or A 2, B 1 — point is B doesn't starve)

Walk through what happens in each model.

### Claim-time lease (general approach)

```
Tick T:
  scheduler reads DB → A has 0 leases, B has 0 leases
  → pick A's task     → bullmq.add(A1)
  scheduler reads DB → A has 0 leases, B has 0 leases   ← unchanged!
  → pick A's task     → bullmq.add(A2)
  scheduler reads DB → A has 0 leases, B has 0 leases
  → pick A's task     → bullmq.add(A3)
  scheduler reads DB → A has 0 leases, B has 0 leases
  → pick A's task     → bullmq.add(A4)

  All 4 slots given to A. B starves.

Workers pop, each writes a lease, but by then the decision is already made.
```

The decision-making query never sees the consequences of its own decisions
within a tick. The DB is "behind" the scheduler.

You could try to compensate in memory: keep a counter inside the scheduler
process. But:

- That counter does not survive a scheduler restart.
- Multiple scheduler instances cannot share it without inventing a distributed
  cache — which is what Postgres already is.
- Workers also need to subtract from it on completion, requiring another
  channel back to the scheduler.

The only consistent shared view is the DB. So the decision must be reflected
in the DB before the next decision is made.

### Reserve-time lease (this project)

```
Tick T:
  scheduler reads DB → A has 0, B has 0
  → pick A's task     → UPDATE A1 SET lease_token=…  (commit) → bullmq.add(A1)
  scheduler reads DB → A has 1, B has 0
  → pick B's task     → UPDATE B1 SET lease_token=…  (commit) → bullmq.add(B1)
  scheduler reads DB → A has 1, B has 1
  → pick A's task     → UPDATE A2 SET lease_token=…  (commit) → bullmq.add(A2)
  scheduler reads DB → A has 2, B has 1
  → pick A's task     → UPDATE A3 SET lease_token=…  (commit) → bullmq.add(A3)

  Slots: A 3, B 1. Fair.
```

Each pick updates the very state the next pick reads. The DB is the
synchronisation point.

---

## Why FIFO / priority systems get away with claim-time leases

Their ordering policy does not depend on "what is currently running". A FIFO
queue's "next task" is determined by enqueue order, full stop. A static-priority
queue compares the priority field on each message, also full stop. Neither
needs to know which user already has 3 active tasks — they don't have a notion
of "user fairness" to begin with.

So the broker can hold the task until a worker is ready, and the worker can
create the lease at claim time, because **no future ordering decision will be
influenced by this task's running state**.

The moment you introduce a policy that depends on global running state —
fairness across users, slot pools, cross-kind backpressure, deadline-aware
scheduling — that simplification breaks. The decision-making now needs a
read-write loop with the DB on every pick.

---

## CPU count's role in this

A natural follow-up: "is this all because CPU slots are limited?"

The cap is the upstream cause, but it is one step removed from the lease-timing
question. Chain it out:

1. **CPU slots are finite (`slotsCap`)** — only K tasks can run at once.
2. **More demand than supply** — pending tasks always exist, so the system
   must *choose* which to run.
3. **Choosing requires a policy** — and the policy is fairness, not FIFO.
4. **Fairness requires live `running_count`** — see above.
5. **Live `running_count` requires reserve-time lease** — so each pick reflects
   in the DB before the next pick reads.

If CPU slots were infinite, step 2 would be empty (run everything immediately),
and steps 3–5 would not exist. Conversely, if CPU is finite but you accept
unfair starvation, you can stop at step 2 and use FIFO. Reserve-time lease is
not a property of "having a slot cap" — it is a property of "wanting fairness
under a slot cap".

---

## Consequence: the queue is reduced to a transport

A second observation falls out of all of this. Look at what `dispatchKind`
does each tick (`lib/scheduler.ts`):

```
free = slotsCap - countActiveLeases(kind)
for i in 0..free:
    reserveOneTask(kind)   # picks exactly one, commits lease
    queue.add(task)
```

It never enqueues more than `free` tasks. The pending backlog stays in
Postgres. BullMQ holds at most a handful of in-flight messages — typically
zero, because workers pop them quickly.

This is **not** an accident. It is the same fairness requirement, looked at
from the other side:

> If the scheduler dumps 1,000 pending tasks into BullMQ all at once,
> the relative order of those 1,000 tasks is frozen at the moment of dump.
> Over the next several seconds new tasks arrive, running tasks finish, and
> the fair ordering changes — but BullMQ keeps feeding workers from its
> stale snapshot. Fairness silently degrades.

So the scheduler defers the decision until the last possible moment: only
when a slot frees does the scheduler pick the next task. This is **late
binding** — the decision is bound to the most current information, not to
the information available at queue-time.

The flip side is that BullMQ's natural responsibilities — buffering,
ordering, priority — all collapse:

| Responsibility       | Where it lives in this design |
| -------------------- | ----------------------------- |
| Buffering            | Postgres `tasks` (`status='pending'`) |
| Priority / ordering  | Postgres `ORDER BY` clause |
| Slot accounting      | Postgres `lease_token IS NOT NULL` count |
| Death detection (post-claim) | Postgres `lease_expires_at` + reaper |
| Death detection (pre-claim)  | BullMQ stalled-job + Postgres reaper |
| Worker pool concurrency | BullMQ |
| Push delivery to workers | BullMQ |
| Retry on visible failure | BullMQ |

BullMQ keeps the last three. Everything that involves "what should run next"
moved to Postgres.

---

## So why keep BullMQ at all?

In principle, this design could replace BullMQ with worker-side polling
(`SELECT ... FOR UPDATE SKIP LOCKED` from `tasks WHERE status='queued'`).
That is what `pg-boss` and `graphile-worker` do. The fairness behaviour
would be identical.

The reasons BullMQ is still here are pragmatic, not architectural:

1. **Push beats poll.** Workers block on `bullmq.pop()` and wake instantly.
   No "every N seconds, ask the DB" overhead.
2. **Worker pool primitives.** Per-worker concurrency, graceful shutdown,
   lifecycle hooks come free.
3. **Existing ecosystem.** Bull Board, metrics exporters, retry shapes.

These are convenience layers, not core layers. Removing BullMQ would not
change correctness; it would change ergonomics. See
`queue-architecture-tradeoffs.md` Option B / C for what the alternative
looks like.

---

## Recovery cost of reserve-time lease

The trade-off is honest. By committing the lease before the publish, a failure
between commit and `bullmq.add` (process crash, Redis blip throwing from
`add`) leaves the row as `queued` with an active lease but no broker
message. The reaper catches it on lease expiry and resets to `pending`
(`reapExpiredLeases` in `lib/scheduler.ts`).

Cost: one full `LEASE_TTL_MS` of recovery latency, during which one slot is
unusable.

This is the same trade-off `queue-architecture-tradeoffs.md` describes; it
is repeated here only to acknowledge that "decisions visible immediately"
costs "decisions undone after a TTL on failure". You cannot have both
properties without introducing a second, faster recovery path (e.g., a
"never-heartbeated" branch in the reaper).

---

## Recap

- General job systems write the lease at **claim time** because their
  ordering policy (FIFO / static priority) does not depend on running state.
- This project writes the lease at **reserve time** because its ordering
  policy (cross-user fairness) depends on live running counts.
- Live running counts have to live in the DB; therefore each pick must
  commit to the DB before the next pick reads.
- The same fairness requirement also forces the scheduler to enqueue
  **only as many tasks as there are free slots** — late binding the decision
  to the latest state.
- Late binding plus "only enqueue what fits" demotes the queue from
  "buffer + ordering authority" to "push-delivery transport". Everything
  policy-related lives in Postgres.
- This is what the lab is teaching: the moment policy depends on global
  state, the broker stops being the right place to hold work.
