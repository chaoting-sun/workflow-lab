// Helpers for translating thrown errors into HTTP responses with consistent
// JSON shape: { error: string, details?: unknown }.

import { ZodError } from "zod";

export interface ApiErrorBody {
  error: string;
  details?: unknown;
}

export function jsonError(
  status: number,
  message: string,
  details?: unknown,
): Response {
  const body: ApiErrorBody = { error: message };
  if (details !== undefined) body.details = details;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function jsonOk(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function badRequestFromZod(err: ZodError): Response {
  return jsonError(400, "invalid request", err.flatten());
}

// Postgres unique-violation error code (`23505`). Surface as 409 to the caller.
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}
