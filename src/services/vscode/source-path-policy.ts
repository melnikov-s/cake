import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Resolves a user-provided source path without permitting escape from its Working Directory. */
export async function resolveSourceTarget(workingDirectory: string, requestedPath: string) {
  if (!requestedPath.trim()) throw new Error("An editor path is required");
  const workspace = await realpath(workingDirectory);
  const candidate = resolve(workspace, requestedPath);
  const ensureInsideWorkspace = (target: string) => {
    const relativePath = relative(workspace, target);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath))
      throw new Error("File is outside the selected project");
    return target;
  };

  let target: string;
  try {
    target = await realpath(candidate);
  } catch {
    const parent = ensureInsideWorkspace(await realpath(dirname(candidate)));
    target = join(parent, basename(candidate));
  }
  return { workspace, target: ensureInsideWorkspace(target) };
}
