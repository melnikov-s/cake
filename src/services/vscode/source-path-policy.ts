import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EditorLocation } from "../../contracts/editor/editor-location";

function filePathFromEditorLocation(requestedPath: string) {
  const value = requestedPath.trim();
  if (!value.startsWith("vscode-remote://")) return value;
  try {
    return decodeURIComponent(new URL(value).pathname);
  } catch {
    throw new Error("The VS Code editor URI is invalid");
  }
}

/** Resolves a user-provided source path without permitting escape from its Working Directory. */
export async function resolveSourceTarget(workingDirectory: string, requestedPath: string) {
  if (!requestedPath.trim()) throw new Error("An editor path is required");
  const workspace = await realpath(workingDirectory);
  const candidate = resolve(workspace, filePathFromEditorLocation(requestedPath));
  const ensureInsideWorkspace = (target: string) => {
    const relativePath = relative(workspace, target);
    if (
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    )
      throw new Error("File is outside the selected project");
    return target;
  };

  // Historical diff paths may have lost their entire parent directory.
  // Resolve the nearest existing ancestor, but never skip a dangling symlink.
  let ancestor = candidate;
  const missing: string[] = [];
  while (true) {
    try {
      const target = join(await realpath(ancestor), ...missing);
      return { workspace, target: ensureInsideWorkspace(target) };
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
      const entry = await lstat(ancestor).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      });
      if (entry || ancestor === workspace) throw cause;
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
}

/** Resolves an editor target while preserving the Project Session's Working Directory. */
export async function resolveEditorTarget(
  workingDirectory: string,
  location: EditorLocation,
): Promise<{ workspace: string; target: string; location: EditorLocation }> {
  if (location.kind === "working-directory") {
    const { workspace, target } = await resolveSourceTarget(workingDirectory, location.path);
    return {
      workspace,
      target,
      location: {
        ...location,
        path: relative(workspace, target).split(sep).join("/"),
      },
    };
  }

  const requestedPath = location.path.trim();
  if (!isAbsolute(requestedPath)) throw new Error("An absolute editor file path is required");
  const { workspace, target } = await resolveSourceTarget(workingDirectory, requestedPath);
  return { workspace, target, location: { ...location, path: target } };
}
