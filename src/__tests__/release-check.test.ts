import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

const root = resolve(".");
const checker = join(root, "scripts/check-public-files.mjs");
let fixture: string;
beforeEach(() => {
  fixture = mkdtempSync(
    join(
      process.platform === "darwin" ? "/private/tmp" : tmpdir(),
      "migration-release-",
    ),
  );
  const files: string[] = JSON.parse(
    readFileSync(join(root, "public-files.json"), "utf8"),
  );
  for (const file of files) {
    mkdirSync(dirname(join(fixture, file)), { recursive: true });
    copyFileSync(join(root, file), join(fixture, file));
  }
});
afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});
function check() {
  return spawnSync(process.execPath, [checker, fixture], { encoding: "utf8" });
}

describe("publication inventory guard", () => {
  it("accepts the explicit source inventory", () => {
    expect(check().status).toBe(0);
  });
  it("refuses local migration state even when gitignored", () => {
    writeFileSync(
      join(fixture, "migration-manifest.json"),
      '{"synthetic":"SENTINEL"}',
    );
    expect(check().status).toBe(1);
    expect(check().stderr).toContain("Unexpected");
  });
  it("refuses symlinks without reading their target", () => {
    const path = join(fixture, "README.md");
    rmSync(path);
    symlinkSync(join(root, "README.md"), path);
    expect(check().status).toBe(1);
    expect(check().stderr).toMatch(/symlink/i);
  });
  it("refuses missing publication inputs", () => {
    rmSync(join(fixture, "SECURITY.md"));
    expect(check().status).toBe(1);
    expect(check().stderr).toContain("Missing");
  });
});
