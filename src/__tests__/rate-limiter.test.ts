import { describe, it, expect, vi, afterEach } from "vitest";
import { RateLimiter } from "../core/rate-limiter.js";
afterEach(() => {
  vi.useRealTimers();
});
describe("API rate limiting", () => {
  it.each([0, -1, NaN, Infinity, 0.5])(
    "rejects invalid configured capacity %s",
    (value) => {
      expect(
        () => new RateLimiter({ maxTokens: value, refillRatePerSecond: value }),
      ).toThrow();
    },
  );
  it("serializes concurrent acquisitions instead of granting the same refill twice", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new RateLimiter({ maxTokens: 1, refillRatePerSecond: 100 });
    const times: number[] = [];
    const requests = Promise.all(
      [0, 1, 2].map(async () => {
        await limiter.acquire();
        times.push(Date.now());
      }),
    );
    await vi.runAllTimersAsync();
    await requests;
    expect(times).toEqual([0, 10, 20]);
  });
});
