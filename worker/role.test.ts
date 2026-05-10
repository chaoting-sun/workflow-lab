import { describe, expect, it } from "vitest";
import { kindsForRole, parseWorkerRole } from "./role";

describe("parseWorkerRole", () => {
  it("accepts 'cpu'", () => {
    expect(parseWorkerRole("cpu")).toBe("cpu");
  });

  it("accepts 'io'", () => {
    expect(parseWorkerRole("io")).toBe("io");
  });

  it("throws when WORKER_ROLE is missing", () => {
    expect(() => parseWorkerRole(undefined)).toThrow(/WORKER_ROLE/);
  });

  it("throws when WORKER_ROLE is empty", () => {
    expect(() => parseWorkerRole("")).toThrow(/WORKER_ROLE/);
  });

  it("throws on an unknown role", () => {
    expect(() => parseWorkerRole("scheduler")).toThrow(/WORKER_ROLE/);
  });
});

describe("kindsForRole", () => {
  it("maps 'cpu' to the cpu kind only", () => {
    expect(kindsForRole("cpu")).toEqual(["cpu"]);
  });

  it("maps 'io' to ssh + training kinds", () => {
    expect(kindsForRole("io")).toEqual(["ssh", "training"]);
  });
});
