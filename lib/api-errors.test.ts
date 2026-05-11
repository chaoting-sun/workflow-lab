import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  badRequestFromZod,
  isUniqueViolation,
  jsonError,
  jsonOk,
} from "./api-errors";

async function readJson(res: Response): Promise<unknown> {
  return JSON.parse(await res.text());
}

describe("jsonError", () => {
  it("returns a Response with the given status and JSON content-type", async () => {
    const res = jsonError(404, "not found");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("serialises { error } when details is omitted", async () => {
    const res = jsonError(400, "bad");
    expect(await readJson(res)).toEqual({ error: "bad" });
  });

  it("includes details when provided", async () => {
    const res = jsonError(422, "invalid", { field: "name" });
    expect(await readJson(res)).toEqual({
      error: "invalid",
      details: { field: "name" },
    });
  });

  it("omits details when explicitly passed undefined", async () => {
    const res = jsonError(500, "boom", undefined);
    const body = (await readJson(res)) as Record<string, unknown>;
    expect(body).toEqual({ error: "boom" });
    expect("details" in body).toBe(false);
  });

  it("preserves falsy detail values (null, 0, empty string) rather than dropping them", async () => {
    expect(await readJson(jsonError(400, "x", null))).toEqual({
      error: "x",
      details: null,
    });
    expect(await readJson(jsonError(400, "x", 0))).toEqual({
      error: "x",
      details: 0,
    });
    expect(await readJson(jsonError(400, "x", ""))).toEqual({
      error: "x",
      details: "",
    });
  });
});

describe("jsonOk", () => {
  it("returns a Response with the given status and JSON content-type", () => {
    const res = jsonOk(201, { id: "abc" });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("serialises the body verbatim", async () => {
    const res = jsonOk(200, { id: "abc", count: 3 });
    expect(await readJson(res)).toEqual({ id: "abc", count: 3 });
  });

  it("supports array bodies", async () => {
    const res = jsonOk(200, [1, 2, 3]);
    expect(await readJson(res)).toEqual([1, 2, 3]);
  });
});

describe("badRequestFromZod", () => {
  const schema = z.object({ name: z.string().min(1) });

  it("returns 400 with error 'invalid request'", async () => {
    const parsed = schema.safeParse({ name: "" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const res = badRequestFromZod(parsed.error);
    expect(res.status).toBe(400);
    const body = (await readJson(res)) as { error: string };
    expect(body.error).toBe("invalid request");
  });

  it("includes the zod flatten() output as details", async () => {
    const parsed = schema.safeParse({ name: "" });
    if (parsed.success) throw new Error("expected zod failure");
    const res = badRequestFromZod(parsed.error);
    const body = (await readJson(res)) as {
      details: { fieldErrors: Record<string, string[]> };
    };
    expect(body.details).toEqual(parsed.error.flatten());
    expect(body.details.fieldErrors.name?.length).toBeGreaterThan(0);
  });
});

describe("isUniqueViolation", () => {
  it("returns true for objects with code '23505'", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("returns true for Error-like objects (pg driver shape) with code '23505'", () => {
    const err = Object.assign(new Error("dup"), { code: "23505" });
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("returns false for other Postgres error codes", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false); // foreign-key violation
    expect(isUniqueViolation({ code: "23502" })).toBe(false); // not-null violation
  });

  it("returns false when the code is numeric 23505 rather than the string", () => {
    // pg surfaces SQLSTATE as a string; guard against a future driver change
    // silently breaking the narrow.
    expect(isUniqueViolation({ code: 23505 })).toBe(false);
  });

  it("returns false for null, undefined, and primitives", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
    expect(isUniqueViolation(23505)).toBe(false);
  });

  it("returns false for objects without a code property", () => {
    expect(isUniqueViolation({})).toBe(false);
    expect(isUniqueViolation({ message: "boom" })).toBe(false);
  });
});
