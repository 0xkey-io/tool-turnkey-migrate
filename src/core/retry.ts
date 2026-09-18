/**
 * Retry utilities with exponential backoff and error classification.
 */

import { ToolError } from "./errors.js";

export class RetryableError extends ToolError {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super("E_API_RETRYABLE", message);
    this.name = "RetryableError";
  }
}

export class NonRetryableError extends ToolError {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super("E_ACTIVITY_BLOCKED", message);
    this.name = "NonRetryableError";
  }
}

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  onRetry?: (attempt: number, error: Error, nextDelayMs: number) => void;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (
    !Number.isInteger(opts.maxAttempts) ||
    opts.maxAttempts < 1 ||
    opts.baseDelayMs < 0 ||
    opts.maxDelayMs < 0
  )
    throw new ToolError("E_RETRY_CONFIG", "Invalid retry settings.");
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));

      if (error instanceof NonRetryableError) {
        throw error;
      }

      lastError = error;

      if (attempt === opts.maxAttempts) break;

      if (!isRetryable(error)) {
        throw error;
      }

      const delay = Math.min(
        opts.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500,
        opts.maxDelayMs,
      );

      opts.onRetry?.(attempt, error, delay);
      await sleep(delay);
    }
  }

  throw lastError ?? new Error("Retry exhausted with no error captured");
}

function isRetryable(error: Error): boolean {
  if (error instanceof RetryableError) return true;
  if (error instanceof NonRetryableError) return false;

  const msg = error.message.toLowerCase();
  if (msg.includes("timeout") || msg.includes("timed out")) return true;
  if (msg.includes("econnreset") || msg.includes("econnrefused")) return true;
  if (msg.includes("socket hang up")) return true;
  if (msg.includes("network")) return true;
  if (msg.includes("429") || msg.includes("rate limit")) return true;
  if (msg.includes("503") || msg.includes("service unavailable")) return true;
  if (msg.includes("502") || msg.includes("bad gateway")) return true;

  // Permission/auth errors are not retryable
  if (msg.includes("permission") || msg.includes("policy")) return false;
  if (msg.includes("signature") || msg.includes("verification failed"))
    return false;
  if (msg.includes("invalid") && !msg.includes("timeout")) return false;
  if (msg.includes("unauthorized") || msg.includes("forbidden")) return false;

  // Unknown failures need investigation rather than speculative retries.
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
