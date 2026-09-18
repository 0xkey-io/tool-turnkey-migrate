import { sleep, NonRetryableError } from "./retry.js";
import { ToolError } from "./errors.js";

export type ActivityStatus =
  | "ACTIVITY_STATUS_CREATED"
  | "ACTIVITY_STATUS_PENDING"
  | "ACTIVITY_STATUS_COMPLETED"
  | "ACTIVITY_STATUS_FAILED"
  | "ACTIVITY_STATUS_CONSENSUS_NEEDED"
  | "ACTIVITY_STATUS_REJECTED";
export interface ActivityReader {
  getActivity(
    activityId: string,
  ): Promise<{ status: string; result?: unknown }>;
}
export interface PollOptions {
  maxWaitMs: number;
  intervalMs: number;
  onPoll?: (status: string, elapsedMs: number) => void;
  initialActivity?: { status: string; result?: unknown };
}
export interface PollResult {
  status: ActivityStatus;
  result?: unknown;
}

export async function pollActivity(
  client: ActivityReader,
  activityId: string,
  options: Partial<PollOptions> = {},
): Promise<PollResult> {
  const opts = { maxWaitMs: 120_000, intervalMs: 2_000, ...options };
  if (opts.maxWaitMs <= 0 || opts.intervalMs <= 0)
    throw new ToolError("E_POLL_CONFIG", "Invalid polling settings.");
  const start = Date.now();
  let initial = opts.initialActivity;
  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed > opts.maxWaitMs)
      throw new NonRetryableError(
        "Activity did not complete within the polling deadline. Preserve state and reconcile it before any further submission.",
      );
    const activity = initial ?? (await client.getActivity(activityId));
    initial = undefined;
    const status = activity.status as ActivityStatus;
    opts.onPoll?.(status, elapsed);
    switch (status) {
      case "ACTIVITY_STATUS_COMPLETED":
        return { status, result: activity.result };
      case "ACTIVITY_STATUS_FAILED":
        throw new NonRetryableError(
          "Activity failed. Reconcile the recorded activity through your deployment operator.",
        );
      case "ACTIVITY_STATUS_REJECTED":
        throw new NonRetryableError(
          "Activity was rejected by policy. Manual review is required.",
        );
      case "ACTIVITY_STATUS_CONSENSUS_NEEDED":
        throw new NonRetryableError(
          "Activity requires consensus approval. Approve the recorded activity, then resume reconciliation.",
        );
      case "ACTIVITY_STATUS_CREATED":
      case "ACTIVITY_STATUS_PENDING":
        await sleep(opts.intervalMs);
        break;
      default:
        throw new NonRetryableError(
          "Activity returned an unsupported status. Manual review is required.",
        );
    }
  }
}
