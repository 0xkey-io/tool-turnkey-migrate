import { describe, it, expect, vi } from "vitest";
import { pollActivity } from "../core/activity-poller.js";
import type { ZeroXKeyTargetClient } from "../core/target-0xkey.js";
import { NonRetryableError } from "../core/retry.js";

function mockClient(statusSequence: string[]): ZeroXKeyTargetClient {
  let callCount = 0;
  return {
    getActivity: vi.fn().mockImplementation(async () => {
      const status =
        statusSequence[Math.min(callCount++, statusSequence.length - 1)];
      return { status, result: { some: "data" } };
    }),
  } as unknown as ZeroXKeyTargetClient;
}

describe("pollActivity", () => {
  it("rejects unknown statuses immediately instead of guessing they are pending", async () => {
    await expect(
      pollActivity(mockClient(["UNKNOWN"]), "act-1", {
        intervalMs: 1,
        maxWaitMs: 10,
      }),
    ).rejects.toThrow(/unsupported status/i);
  });

  it("accepts an already completed submission without another API call", async () => {
    const client = mockClient(["ACTIVITY_STATUS_FAILED"]);
    const result = await pollActivity(client, "act-1", {
      initialActivity: {
        status: "ACTIVITY_STATUS_COMPLETED",
        result: { safe: true },
      },
    });
    expect(result.result).toEqual({ safe: true });
    expect(client.getActivity).not.toHaveBeenCalled();
  });
  it("should return immediately for completed activities", async () => {
    const client = mockClient(["ACTIVITY_STATUS_COMPLETED"]);
    const result = await pollActivity(client, "act-1", { intervalMs: 10 });
    expect(result.status).toBe("ACTIVITY_STATUS_COMPLETED");
    expect(client.getActivity).toHaveBeenCalledTimes(1);
  });

  it("should poll until completion", async () => {
    const client = mockClient([
      "ACTIVITY_STATUS_PENDING",
      "ACTIVITY_STATUS_PENDING",
      "ACTIVITY_STATUS_COMPLETED",
    ]);
    const result = await pollActivity(client, "act-2", {
      intervalMs: 10,
      maxWaitMs: 5000,
    });
    expect(result.status).toBe("ACTIVITY_STATUS_COMPLETED");
    expect(client.getActivity).toHaveBeenCalledTimes(3);
  });

  it("should throw NonRetryableError on failure", async () => {
    const client = mockClient(["ACTIVITY_STATUS_FAILED"]);
    await expect(
      pollActivity(client, "act-3", { intervalMs: 10 }),
    ).rejects.toThrow(NonRetryableError);
  });

  it("should throw NonRetryableError on rejected", async () => {
    const client = mockClient(["ACTIVITY_STATUS_REJECTED"]);
    await expect(
      pollActivity(client, "act-4", { intervalMs: 10 }),
    ).rejects.toThrow("rejected by policy");
  });

  it("should throw NonRetryableError on consensus needed", async () => {
    const client = mockClient(["ACTIVITY_STATUS_CONSENSUS_NEEDED"]);
    await expect(
      pollActivity(client, "act-5", { intervalMs: 10 }),
    ).rejects.toThrow("consensus approval");
  });

  it("should timeout if activity stays pending", async () => {
    const client = mockClient(["ACTIVITY_STATUS_PENDING"]);
    await expect(
      pollActivity(client, "act-6", { intervalMs: 10, maxWaitMs: 50 }),
    ).rejects.toThrow("did not complete");
  });

  it("should invoke onPoll callback", async () => {
    const client = mockClient([
      "ACTIVITY_STATUS_PENDING",
      "ACTIVITY_STATUS_COMPLETED",
    ]);
    const onPoll = vi.fn();
    await pollActivity(client, "act-7", {
      intervalMs: 10,
      maxWaitMs: 5000,
      onPoll,
    });
    expect(onPoll).toHaveBeenCalledWith(
      "ACTIVITY_STATUS_PENDING",
      expect.any(Number),
    );
    expect(onPoll).toHaveBeenCalledWith(
      "ACTIVITY_STATUS_COMPLETED",
      expect.any(Number),
    );
  });
});
