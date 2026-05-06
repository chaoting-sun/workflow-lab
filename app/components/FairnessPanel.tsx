"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import type { SlotCaps, TaskKind, UserView } from "@/lib/types";

const POLL_MS = 3000;

type RunningCountField = keyof Omit<UserView, "id" | "name">;

interface KindSpec {
  kind: TaskKind;
  label: string;
  countField: RunningCountField;
  capField: keyof SlotCaps;
}

const KINDS: readonly KindSpec[] = [
  { kind: "cpu", label: "CPU", countField: "runningCpu", capField: "globalCpuSlots" },
  { kind: "ssh", label: "SSH", countField: "runningSsh", capField: "globalSshSlots" },
  { kind: "training", label: "Train", countField: "runningTraining", capField: "globalTrainingSlots" },
];

export function FairnessPanel(): React.ReactElement {
  const [users, setUsers] = useState<UserView[] | null>(null);
  const [caps, setCaps] = useState<SlotCaps | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Slot caps are env-fixed for the process lifetime; one-shot fetch only.
  useEffect(() => {
    const ctrl = new AbortController();
    apiFetch<SlotCaps>("/api/config", { cache: "no-store", signal: ctrl.signal })
      .then(setCaps)
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "fetch failed");
      });
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      try {
        const data = await apiFetch<UserView[]>("/api/users", {
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (cancelled) return;
        setUsers((prev) => (sameUsers(prev, data) ? prev : data));
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

  if (users === null) {
    return <p className="text-sm text-neutral-500">Loading fairness…</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="text-sm text-amber-700">
          Polling error: {error}
        </p>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {KINDS.map((k) => {
          const used = users.reduce((s, u) => s + u[k.countField], 0);
          return (
            <GlobalStat
              key={k.kind}
              label={k.label}
              used={used}
              cap={caps?.[k.capField]}
            />
          );
        })}
      </div>
      {users.length === 0 ? (
        <p className="text-sm text-neutral-500">No users yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="py-1 pr-2 font-medium">User</th>
              {KINDS.map((k) => (
                <th
                  key={k.kind}
                  className="py-1 px-2 font-medium text-right last:pl-2 last:pr-0"
                >
                  {k.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-neutral-100">
                <td className="py-1 pr-2 truncate">{u.name}</td>
                {KINDS.map((k) => (
                  <td
                    key={k.kind}
                    className="py-1 px-2 text-right tabular-nums last:pl-2 last:pr-0"
                  >
                    {u[k.countField]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function GlobalStat({
  label,
  used,
  cap,
}: {
  label: string;
  used: number;
  cap: number | undefined;
}): React.ReactElement {
  return (
    <span className="text-neutral-700">
      <span className="font-medium">{label}</span>{" "}
      <span className="tabular-nums">
        {used}
        {cap !== undefined && `/${cap}`}
      </span>
    </span>
  );
}

function sameUsers(prev: UserView[] | null, next: UserView[]): boolean {
  if (prev === null || prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const p = prev[i];
    const n = next[i];
    if (p.id !== n.id) return false;
    for (const k of KINDS) {
      if (p[k.countField] !== n[k.countField]) return false;
    }
  }
  return true;
}
