"use client";

import { useCallback, useEffect, useState } from "react";
import { CreateUserForm } from "./components/UserPicker";
import { SubmitJobForm } from "./components/SubmitForm";
import { JobList } from "./components/JobList";
import { apiFetch } from "@/lib/api-client";
import type { User } from "@/lib/types";

export default function Page(): React.ReactElement {
  const [users, setUsers] = useState<User[]>([]);
  const [usersError, setUsersError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    apiFetch<User[]>("/api/users", { cache: "no-store", signal: ctrl.signal })
      .then(setUsers)
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setUsersError(err instanceof Error ? err.message : "fetch failed");
      });
    return () => ctrl.abort();
  }, []);

  const handleUserCreated = useCallback((u: User) => {
    setUsers((prev) => (prev.some((p) => p.id === u.id) ? prev : [...prev, u]));
  }, []);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Workflow Lab</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Submit jobs and watch CPU → SSH → training progress in real time.
        </p>
      </header>

      <section className="flex flex-col gap-3 rounded border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
          Users
        </h2>
        <CreateUserForm onCreated={handleUserCreated} />
        {usersError && (
          <p role="alert" className="text-sm text-amber-700">
            Could not load users: {usersError}
          </p>
        )}
        {users.length === 0 ? (
          <p className="text-sm text-neutral-500">No users yet.</p>
        ) : (
          <p className="text-sm text-neutral-700">
            {users.length} user{users.length === 1 ? "" : "s"}:{" "}
            {users.map((u) => u.name).join(", ")}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
          Submit job
        </h2>
        <SubmitJobForm users={users} />
      </section>

      <section className="flex flex-col gap-3 rounded border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
          Jobs
        </h2>
        <JobList users={users} />
      </section>
    </main>
  );
}
