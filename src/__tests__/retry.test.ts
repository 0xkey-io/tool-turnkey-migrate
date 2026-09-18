import { describe, it, expect, vi } from "vitest";
import {
  withRetry,
  NonRetryableError,
  RetryableError,
  sleep,
} from "../core/retry.js";

describe("withRetry", () => {
  it("should return immediately on success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should retry on transient errors", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue("recovered");

    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("should not retry NonRetryableError", async () => {
    const fn = vi.fn().mockRejectedValue(new NonRetryableError("permanent"));
    await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow(
      "permanent",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should not retry auth errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("unauthorized"));
    await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow(
      "unauthorized",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should retry RetryableError explicitly", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError("try again"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, { maxAttempts: 2, baseDelayMs: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should throw after exhausting all attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("timeout forever"));
    await expect(
      withRetry(fn, { maxAttempts: 2, baseDelayMs: 10 }),
    ).rejects.toThrow("timeout forever");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should invoke onRetry callback", async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("network issue"))
      .mockResolvedValue("ok");

    await withRetry(fn, { maxAttempts: 2, baseDelayMs: 10, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      1,
      expect.any(Error),
      expect.any(Number),
    );
  });
});

describe("sleep", () => {
  it("should resolve after given milliseconds", async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});
