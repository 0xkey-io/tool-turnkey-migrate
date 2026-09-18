import { describe, it, expect } from "vitest";
import { SecureBuffer, withSecureValue } from "../core/secure-memory.js";

describe("SecureBuffer", () => {
  it("should store and retrieve string values", () => {
    const buf = SecureBuffer.fromString("hello secret");
    expect(buf.toString()).toBe("hello secret");
    expect(buf.isZeroed).toBe(false);
  });

  it("should zero the buffer on demand", () => {
    const buf = SecureBuffer.fromString("sensitive");
    buf.zero();
    expect(buf.isZeroed).toBe(true);
    expect(() => buf.toString()).toThrow("already zeroed");
  });

  it("should handle hex encoding", () => {
    const buf = SecureBuffer.fromHex("0xdeadbeef");
    expect(buf.toHex()).toBe("deadbeef");
    buf.zero();
    expect(() => buf.toHex()).toThrow("already zeroed");
  });

  it("should be idempotent on multiple zero() calls", () => {
    const buf = SecureBuffer.fromString("test");
    buf.zero();
    buf.zero();
    expect(buf.isZeroed).toBe(true);
  });
});

describe("withSecureValue", () => {
  it("should provide value to callback and clean up", async () => {
    let captured = "";
    await withSecureValue("my-secret", async (val) => {
      captured = val;
    });
    expect(captured).toBe("my-secret");
  });

  it("should clean up even on error", async () => {
    await expect(
      withSecureValue("secret", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
