import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Resolves a renderer hint only when it matches a main-owned, user-approved active project. */
export async function resolveRewordingWorkspace(options: {
  requestedWorkspace: string | undefined;
  activeWorkspace: string | undefined;
  allowedWorkspacePaths: ReadonlySet<string>;
}) {
  const { requestedWorkspace, activeWorkspace, allowedWorkspacePaths } = options;
  if (
    !requestedWorkspace ||
    !isAbsolute(requestedWorkspace) ||
    !activeWorkspace ||
    !allowedWorkspacePaths.has(activeWorkspace)
  )
    return undefined;
  try {
    const [requested, active] = await Promise.all([
      realpath(requestedWorkspace),
      realpath(activeWorkspace),
    ]);
    if (requested !== active || !(await stat(active)).isDirectory()) return undefined;
    return active;
  } catch {
    return undefined;
  }
}
