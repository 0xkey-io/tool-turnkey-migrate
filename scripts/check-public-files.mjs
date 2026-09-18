#!/usr/bin/env node
/** Reject local state and unexpected publication inputs, including gitignored files. */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { resolve, join, parse, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

const root = resolve(process.argv[2] ?? ".");
const errors = [];
const generated = new Set(["node_modules", "dist", "coverage", ".git"]);
function safeAncestors(path) {
  let current = parse(path).root;
  for (const part of path
    .slice(current.length)
    .split(/[\\/]/)
    .filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw new Error("Publication root has a symlink ancestor.");
  }
}
function readJson(file) {
  return JSON.parse(readFileSync(join(root, file), "utf8"));
}
function allowedPath(path) {
  return (
    typeof path === "string" &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !path.split("/").some((part) => part === ".." || generated.has(part)) &&
    !/(^|\/)(?:migration\.yaml|migration-manifest[^/]*|\.env[^/]*|[^/]*\.log|[^/]*\.lock|[^/]*\.tmp)$/.test(
      path,
    )
  );
}
try {
  safeAncestors(root);
  const inventoryPath = join(root, "public-files.json");
  if (lstatSync(inventoryPath).isSymbolicLink())
    throw new Error("Inventory is a symlink.");
  const files = readJson("public-files.json");
  if (
    !Array.isArray(files) ||
    files.some((file) => !allowedPath(file)) ||
    new Set(files).size !== files.length
  )
    throw new Error("Invalid publication file inventory.");
  const allowed = new Set(files);
  const found = new Set();
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split("\\").join("/");
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        errors.push(`Refusing symlink: ${name}`);
        continue;
      }
      if (directory === root && generated.has(entry.name)) continue;
      if (info.isDirectory()) walk(path);
      else if (!info.isFile() || info.nlink !== 1)
        errors.push(`Not a regular single-link file: ${name}`);
      else {
        found.add(name);
        if (!allowed.has(name))
          errors.push(`Unexpected publication file: ${name}`);
        if (
          allowed.has(name) &&
          /\/(?:Users|home)\/[A-Za-z0-9_-]+\/(?:codes|\.codex)\//.test(
            readFileSync(path, "utf8"),
          )
        )
          errors.push(`Local workspace path in public content: ${name}`);
      }
    }
  }
  walk(root);
  for (const name of allowed)
    if (!found.has(name)) errors.push(`Missing publication file: ${name}`);
  if (!errors.length) {
    const pkg = readJson("package.json");
    if (pkg.private !== true || pkg.license !== "Apache-2.0")
      errors.push(
        "Expected private npm package metadata with Apache-2.0 license.",
      );
    for (const versions of [pkg.dependencies, pkg.devDependencies]) {
      if (
        Object.values(versions ?? {}).some(
          (version) => !/^\d+\.\d+\.\d+$/.test(version),
        )
      )
        errors.push("Dependencies must use exact registry versions.");
    }
    const lock = readJson("package-lock.json");
    if (lock.name !== pkg.name || lock.version !== pkg.version)
      errors.push("Lockfile package identity does not match.");
    for (const entry of Object.values(lock.packages ?? {})) {
      if (entry.link) errors.push("Lockfile contains local dependency links.");
      if (entry.resolved) {
        try {
          const url = new URL(entry.resolved);
          if (
            url.origin !== "https://registry.npmjs.org" ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          )
            errors.push(
              "Lockfile contains a non-public or credential-bearing endpoint.",
            );
        } catch {
          errors.push(
            "Lockfile contains a local or invalid dependency endpoint.",
          );
        }
      }
    }
    const example = parseYaml(
      readFileSync(join(root, "migration.example.yaml"), "utf8"),
    );
    const reference = /^\$[A-Z_][A-Z0-9_]*$/;
    for (const name of ["source", "target"])
      for (const key of ["apiPublicKey", "apiPrivateKey", "organizationId"])
        if (!reference.test(example?.[name]?.[key] ?? ""))
          errors.push(
            "Example credentials and organization IDs must be environment references.",
          );
    for (const key of ["apiBaseUrl", "userId", "signerPublicKey"])
      if (!reference.test(example?.target?.[key] ?? ""))
        errors.push(
          "Example target deployment context must use environment references.",
        );
    if (
      !Array.isArray(example?.resources?.wallets) ||
      example.resources.wallets.length ||
      !Array.isArray(example?.resources?.privateKeys) ||
      example.resources.privateKeys.length
    )
      errors.push("Example must select no resources by default.");
  }
  // Generated directories may exist locally but must never be tracked for publication.
  const tracked = spawnSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
  });
  if (tracked.status === 0)
    for (const name of tracked.stdout.split("\0").filter(Boolean))
      if (!allowed.has(name))
        errors.push(`Unexpected tracked publication file: ${name}`);
} catch (error) {
  errors.push(
    error instanceof Error && /symlink/.test(error.message)
      ? error.message
      : "Unable to validate publication inventory/metadata safely.",
  );
}
if (errors.length) {
  process.stderr.write(errors.join("\n") + "\n");
  process.exitCode = 1;
} else
  process.stdout.write(
    "Public file inventory and metadata checks passed. Run Gitleaks and review content before publication.\n",
  );
