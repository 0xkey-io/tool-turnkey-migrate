import { describe, it, expect, vi } from "vitest";
import { assertSafePath } from "../core/safe-files.js";
import { lstat } from "node:fs/promises";
vi.mock("node:fs/promises", () => ({ lstat: vi.fn(), open: vi.fn() }));
describe("trusted filesystem ancestor ownership", () => {
  it("rejects another user's mode755 ancestor", async () => {
    vi.mocked(lstat).mockResolvedValue({
      isSymbolicLink: () => false,
      isDirectory: () => true,
      isFile: () => false,
      mode: 0o755,
      uid: (process.getuid?.() ?? 1000) + 10000,
    } as Awaited<ReturnType<typeof lstat>>);
    await expect(assertSafePath("/foreign/state.json", true)).rejects.toThrow(
      /owner|trusted/i,
    );
  });
});
