import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = resolve("src/cli/index.ts");
const tsx = resolve("node_modules/tsx/dist/cli.mjs");
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(
    join(
      process.platform === "darwin" ? "/private/tmp" : tmpdir(),
      "migration-cli-",
    ),
  );
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});
function run(args: string[]) {
  return spawnSync(process.execPath, [tsx, entry, ...args], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env },
  });
}

describe("CLI write authorization and safe diagnostics", () => {
  it.each(["run", "resume"])(
    "requires confirmation before initializing %s",
    (command) => {
      const config = join(directory, "migration.yaml");
      writeFileSync(config, "intentionally invalid config");
      const result = run([command, "--config", config]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--confirm");
      expect(existsSync(join(directory, "manifest.json"))).toBe(false);
    },
  );
  it.each(["0", "-1", "1.5", "5junk", "NaN"])(
    "rejects invalid rate limit %s before reading credentials",
    (rps) => {
      const result = run([
        "run",
        "--config",
        "missing.yaml",
        "--confirm",
        "--rps",
        rps,
      ]);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/rate|rps|options/i);
    },
  );
  it("does not expose YAML parser snippets containing credentials", () => {
    const config = join(directory, "migration.yaml");
    writeFileSync(
      config,
      "source:\n  apiPrivateKey: [SYNTHETIC_PRIVATE_SENTINEL\n",
    );
    const result = run(["plan", "--config", config]);
    expect(result.status).toBe(2);
    expect(result.stderr + result.stdout).not.toContain(
      "SYNTHETIC_PRIVATE_SENTINEL",
    );
  });
  it("supports help without loading credentials", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("validate-data");
  });
});
