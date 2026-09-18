import { safeError } from "./errors.js";
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}
const priority: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const secretField =
  /private.?key|mnemonic|seed|bundle|authorization|password|credential|secret|token|stamp/i;

export function createLogger(
  options: { level?: LogLevel; json?: boolean; redactValues?: string[] } = {},
): Logger {
  const secrets = (options.redactValues ?? [])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const redact = (text: string) =>
    secrets.reduce(
      (value, secret) => value.split(secret).join("[REDACTED]"),
      text,
    );
  function sanitize(
    value: unknown,
    seen = new WeakSet<object>(),
    depth = 0,
  ): unknown {
    if (typeof value === "string") return redact(value);
    if (value instanceof Error) return redact(safeError(value));
    if (Buffer.isBuffer(value)) return "[REDACTED]";
    if (!value || typeof value !== "object") return value;
    if (depth > 10) return "[TRUNCATED]";
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    if (Array.isArray(value))
      return value.map((v) => sanitize(v, seen, depth + 1));
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        secretField.test(key) ? "[REDACTED]" : sanitize(entry, seen, depth + 1),
      ]),
    );
  }
  function log(
    level: LogLevel,
    msg: string,
    meta?: Record<string, unknown>,
  ): void {
    if (priority[level] < priority[options.level ?? "info"]) return;
    const clean = sanitize(meta ?? {}) as Record<string, unknown>;
    const message = redact(msg).replaceAll("\x1b", "");
    const entry = {
      ...clean,
      level,
      msg: message,
      ts: new Date().toISOString(),
    };
    // Stdout is reserved for command results, especially --json.
    process.stderr.write(
      options.json
        ? JSON.stringify(entry) + "\n"
        : `[${level}] ${message} ${JSON.stringify(clean)}\n`,
    );
  }
  return {
    debug: (msg, meta) => log("debug", msg, meta),
    info: (msg, meta) => log("info", msg, meta),
    warn: (msg, meta) => log("warn", msg, meta),
    error: (msg, meta) => log("error", msg, meta),
  };
}
