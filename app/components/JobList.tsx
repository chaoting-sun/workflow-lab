"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import type { JobView, ProgressCounts, User } from "@/lib/types";

const POLL_MS = 1000;

interface Props {
  users: User[];
}

export function JobList({ users }: Props): React.ReactElement {
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      try {
        const data = await apiFetch<JobView[]>("/api/jobs", {
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (cancelled) return;
        // Skip setState when nothing changed so the list does not reconcile every poll.
        setJobs((prev) => (sameJobs(prev, data) ? prev : data));
        setError((prev) => (prev === null ? prev : null));
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "fetch failed");
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_MS);
      }
    };
    void tick();

    return () => {
      cancelled = true;
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (jobs === null) {
    return <p className="text-sm text-neutral-500">Loading jobs…</p>;
  }
  if (jobs.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        No jobs yet. Submit one above to see progress here.
      </p>
    );
  }

  const userNames = new Map(users.map((u) => [u.id, u.name]));

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p role="alert" className="text-sm text-amber-700">
          Polling error: {error}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {jobs.map((j) => (
          <JobRow key={j.id} job={j} userName={userNames.get(j.userId)} />
        ))}
      </ul>
    </div>
  );
}

function sameProgress(a: ProgressCounts, b: ProgressCounts): boolean {
  return a.done === b.done && a.total === b.total && a.failed === b.failed;
}

function sameJobs(prev: JobView[] | null, next: JobView[]): boolean {
  if (prev === null || prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const p = prev[i];
    const n = next[i];
    if (p.id !== n.id || p.status !== n.status) return false;
    if (
      !sameProgress(p.progress.cpu, n.progress.cpu) ||
      !sameProgress(p.progress.ssh, n.progress.ssh) ||
      !sameProgress(p.progress.training, n.progress.training)
    ) {
      return false;
    }
  }
  return true;
}

function JobRow({
  job,
  userName,
}: {
  job: JobView;
  userName: string | undefined;
}): React.ReactElement {
  return (
    <li className="rounded border border-neutral-200 bg-white p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-mono text-xs text-neutral-500 truncate">
            {job.id.slice(0, 8)}
          </span>
          <span className="text-sm font-medium">
            {userName ?? job.userId.slice(0, 8)}
          </span>
        </div>
        <StatusBadge status={job.status} />
      </div>
      <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-3">
        <ProgressBar label="CPU" counts={job.progress.cpu} />
        <ProgressBar label="SSH" counts={job.progress.ssh} />
        <ProgressBar label="Train" counts={job.progress.training} />
      </div>
    </li>
  );
}

function StatusBadge({ status }: { status: JobView["status"] }): React.ReactElement {
  const palette: Record<JobView["status"], string> = {
    pending: "bg-neutral-100 text-neutral-700",
    running: "bg-blue-100 text-blue-700",
    completed: "bg-emerald-100 text-emerald-700",
    failed: "bg-red-100 text-red-700",
  };
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium ${palette[status]}`}
    >
      {status}
    </span>
  );
}

function ProgressBar({
  label,
  counts,
}: {
  label: string;
  counts: ProgressCounts;
}): React.ReactElement {
  const pct =
    counts.total === 0 ? 0 : Math.round((counts.done / counts.total) * 100);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between text-xs text-neutral-600">
        <span>{label}</span>
        <span>
          {counts.done}/{counts.total}
          {counts.failed > 0 && (
            <span className="ml-1 text-red-600">({counts.failed} failed)</span>
          )}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded bg-neutral-200"
        role="progressbar"
        aria-valuenow={counts.done}
        aria-valuemin={0}
        aria-valuemax={counts.total}
      >
        <div
          className={`h-full ${counts.failed > 0 ? "bg-red-500" : "bg-emerald-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
