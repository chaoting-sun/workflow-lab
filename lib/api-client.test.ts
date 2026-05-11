import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api-client";

function mockFetch(
  impl: (input: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const fn = vi.fn(impl);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("apiFetch", () => {
  it("returns parsed JSON on 2xx", async () => {
    mockFetch(() => new Response(JSON.stringify({ id: "u1" }), { status: 200 }));
    const body = await apiFetch<{ id: string }>("/api/users");
    expect(body).toEqual({ id: "u1" });
  });

  it("passes through the input and init to fetch", async () => {
    const fetchFn = mockFetch(
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await apiFetch("/api/jobs", { method: "POST", body: "{}" });
    expect(fetchFn).toHaveBeenCalledWith("/api/jobs", { method: "POST", body: "{}" });
  });

  it("throws with the server-supplied error on non-2xx with JSON body", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: "user already exists" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(apiFetch("/api/users")).rejects.toThrow("user already exists");
  });

  it("falls back to a status-coded message when the body is not JSON", async () => {
    mockFetch(
      () =>
        new Response("<html>500</html>", {
          status: 500,
          headers: { "content-type": "text/html" },
        }),
    );
    await expect(apiFetch("/api/jobs")).rejects.toThrow("request failed (500)");
  });

  it("falls back to a status-coded message when the JSON body has no error field", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ message: "nope" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(apiFetch("/api/users")).rejects.toThrow("request failed (400)");
  });
});
