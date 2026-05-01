"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-client";
import type { User } from "@/lib/types";

interface Props {
  users: User[];
}

export function SubmitJobForm({ users }: Props): React.ReactElement {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    const userId = new FormData(e.currentTarget).get("userId");
    if (typeof userId !== "string") return;

    setSubmitting(true);
    setError(null);
    try {
      await apiFetch<unknown>("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to submit job");
    } finally {
      setSubmitting(false);
    }
  }

  if (users.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        Create a user first, then you can submit a job.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-neutral-700">User</span>
        <select
          name="userId"
          defaultValue={users[0].id}
          disabled={submitting}
          className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm focus:border-neutral-500 focus:outline-none disabled:bg-neutral-100"
        >
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={submitting}
        className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:bg-neutral-400"
      >
        {submitting ? "Submitting…" : "Submit job"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </form>
  );
}
