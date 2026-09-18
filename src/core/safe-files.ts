/** Local state is never read or written through symbolic links. */
import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, parse, join, dirname } from "node:path";
import { ToolError } from "./errors.js";

export async function assertSafePath(
  path: string,
  allowMissingLeaf = false,
  allowDirectoryLeaf = false,
): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new ToolError(
          "E_UNSAFE_PATH",
          "Symbolic links are not allowed in configuration or state paths.",
        );
      if (
        i < parts.length - 1 &&
        info.uid !== 0 &&
        info.uid !== process.getuid?.()
      )
        throw new ToolError(
          "E_UNSAFE_PATH",
          "Path ancestor ownership must belong to the current user or trusted root.",
        );
      if (
        i < parts.length - 1 &&
        (info.mode & 0o022) !== 0 &&
        !((info.mode & 0o1000) !== 0 && info.uid === 0)
      )
        throw new ToolError(
          "E_UNSAFE_PATH",
          "Path ancestors must not be writable by other users.",
        );
      if (i < parts.length - 1 && !info.isDirectory())
        throw new ToolError(
          "E_UNSAFE_PATH",
          "A path parent is not a directory.",
        );
      if (
        i === parts.length - 1 &&
        !(allowDirectoryLeaf && info.isDirectory()) &&
        (!info.isFile() || info.nlink !== 1)
      )
        throw new ToolError(
          "E_UNSAFE_PATH",
          "The path must be a regular file without hard links.",
        );
    } catch (error) {
      if (
        allowMissingLeaf &&
        i === parts.length - 1 &&
        hasCode(error, "ENOENT")
      )
        return;
      throw error;
    }
  }
}

export function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export async function readSafeText(path: string): Promise<string> {
  await assertSafePath(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 * 1024) {
      throw new ToolError(
        "E_UNSAFE_FILE",
        "Expected a regular configuration or state file no larger than 16 MiB.",
      );
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function privateStateDirectory(
  path: string,
): Promise<{ ino: number; dev: number }> {
  await assertSafePath(dirname(resolve(path)), false, true);
  const info = await lstat(dirname(resolve(path)));
  if (
    typeof process.getuid !== "function" ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0
  )
    throw new ToolError(
      "E_STATE_DIRECTORY",
      "State requires a private owner-only directory (chmod 700) on macOS or Linux.",
    );
  return { ino: info.ino, dev: info.dev };
}
