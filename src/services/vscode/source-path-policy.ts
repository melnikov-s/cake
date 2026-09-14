import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EditorLocation } from "../../ipc/editor-location";

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
  const workspace = await realpath(workingDirectory);
  let target: string;
  try {
    target = await realpath(requestedPath);
  } catch {
    target = join(await realpath(dirname(requestedPath)), basename(requestedPath));
  }
  return { workspace, target, location: { ...location, path: target } };
}
