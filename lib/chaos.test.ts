import { describe, expect, it, vi } from "vitest";
import { maybeCrash, maybeOversleep, maybeSkipArtifact } from "./chaos";

describe("maybeCrash", () => {
  it("does nothing when rate is 0 — no dice roll, no exit", () => {
    const exit = vi.fn();
    const random = vi.fn(() => 0);
    maybeCrash(0, { random, exit: exit as never });
    expect(random).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits with code 1 when the random roll lands strictly below rate", () => {
    const exit = vi.fn();
    maybeCrash(0.5, { random: () => 0.4, exit: exit as never });
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does not exit when the random roll equals rate (half-open interval [0, rate))", () => {
    const exit = vi.fn();
    maybeCrash(0.5, { random: () => 0.5, exit: exit as never });
    expect(exit).not.toHaveBeenCalled();
  });

  it("does not exit when the random roll is above rate", () => {
    const exit = vi.fn();
    maybeCrash(0.5, { random: () => 0.99, exit: exit as never });
    expect(exit).not.toHaveBeenCalled();
  });

  it("always exits when rate is 1", () => {
    const exit = vi.fn();
    maybeCrash(1, { random: () => 0.999, exit: exit as never });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("samples the random source exactly once per call", () => {
    const exit = vi.fn();
    const random = vi.fn(() => 0.9);
    maybeCrash(0.5, { random, exit: exit as never });
    expect(random).toHaveBeenCalledTimes(1);
  });
});

describe("maybeOversleep", () => {
  it("returns false when rate is 0 — no dice roll", () => {
    const random = vi.fn(() => 0);
    expect(maybeOversleep(0, random)).toBe(false);
    expect(random).not.toHaveBeenCalled();
  });

  it("returns true when the random roll lands strictly below rate", () => {
    expect(maybeOversleep(0.5, () => 0.49)).toBe(true);
  });

  it("returns false when the random roll equals rate", () => {
    expect(maybeOversleep(0.5, () => 0.5)).toBe(false);
  });

  it("returns false when the random roll is above rate", () => {
    expect(maybeOversleep(0.5, () => 0.51)).toBe(false);
  });

  it("returns true on every call when rate is 1", () => {
    expect(maybeOversleep(1, () => 0.999)).toBe(true);
  });

  it("samples the random source exactly once per call", () => {
    const random = vi.fn(() => 0.1);
    maybeOversleep(0.5, random);
    expect(random).toHaveBeenCalledTimes(1);
  });
});

describe("maybeSkipArtifact", () => {
  it("returns false when rate is 0 — no dice roll", () => {
    const random = vi.fn(() => 0);
    expect(maybeSkipArtifact(0, random)).toBe(false);
    expect(random).not.toHaveBeenCalled();
  });

  it("returns true when the random roll lands strictly below rate", () => {
    expect(maybeSkipArtifact(0.3, () => 0.29)).toBe(true);
  });

  it("returns false when the random roll equals rate", () => {
    expect(maybeSkipArtifact(0.3, () => 0.3)).toBe(false);
  });

  it("returns false when the random roll is above rate", () => {
    expect(maybeSkipArtifact(0.3, () => 0.4)).toBe(false);
  });

  it("samples the random source exactly once per call", () => {
    const random = vi.fn(() => 0.1);
    maybeSkipArtifact(0.5, random);
    expect(random).toHaveBeenCalledTimes(1);
  });
});
