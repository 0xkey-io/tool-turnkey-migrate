import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger } from "../core/logger.js";
afterEach(() => {
  vi.restoreAllMocks();
});

describe("safe diagnostic output", () => {
  it("redacts nested secret fields and registered credentials", () => {
    const output: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const log = createLogger({
      json: true,
      redactValues: ["SYNTHETIC_CREDENTIAL"],
    });
    log.error("API failed with SYNTHETIC_CREDENTIAL", {
      nested: {
        apiPrivateKey: "SYNTHETIC_KEY",
        encryptedBundle: "SYNTHETIC_BUNDLE",
      },
      error: new Error("SYNTHETIC_ERROR_PAYLOAD"),
    });
    const text = output.join("");
    expect(text).not.toMatch(/SYNTHETIC_(CREDENTIAL|KEY|BUNDLE|ERROR_PAYLOAD)/);
    expect(JSON.parse(text).level).toBe("error");
  });
  it("keeps informational diagnostics off JSON result stdout", () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    createLogger({ json: true }).info("Source discovery completed");
    expect(stdout).not.toHaveBeenCalled();
  });
});
