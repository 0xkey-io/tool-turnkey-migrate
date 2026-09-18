import { sleep } from "./retry.js";
import { ToolError } from "./errors.js";
export interface RateLimiterOptions {
  maxTokens: number;
  refillRatePerSecond: number;
}

/** Token bucket with a serialized queue so concurrent callers cannot share a refill. */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly options: RateLimiterOptions) {
    if (
      Object.values(options).some(
        (n) => !Number.isSafeInteger(n) || n < 1 || n > 100,
      )
    ) {
      throw new ToolError(
        "E_RATE_CONFIG",
        "API rate/capacity must be an integer from 1 to 100.",
      );
    }
    this.tokens = options.maxTokens;
  }
  acquire(): Promise<void> {
    const request = this.tail.then(async () => {
      this.refill();
      while (this.tokens < 1) {
        await sleep(
          Math.ceil(
            ((1 - this.tokens) / this.options.refillRatePerSecond) * 1000,
          ),
        );
        this.refill();
      }
      this.tokens--;
    });
    this.tail = request.catch(() => {});
    return request;
  }
  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(
      this.options.maxTokens,
      this.tokens +
        (Math.max(0, now - this.lastRefill) / 1000) *
          this.options.refillRatePerSecond,
    );
    this.lastRefill = now;
  }
}
