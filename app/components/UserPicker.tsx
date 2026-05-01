"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-client";
import type { User } from "@/lib/types";

interface Props {
  onCreated: (user: User) => void;
}

export function CreateUserForm({ onCreated }: Props): React.ReactElement {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const user = await apiFetch<User>("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      onCreated(user);
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create user");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-neutral-700">User name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={submitting}
          maxLength={120}
          className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm focus:border-neutral-500 focus:outline-none disabled:bg-neutral-100"
          placeholder="e.g. alice"
        />
      </label>
      <button
        type="submit"
        disabled={submitting || name.trim().length === 0}
        className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:bg-neutral-400"
      >
        {submitting ? "Creating…" : "Create user"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </form>
  );
}
