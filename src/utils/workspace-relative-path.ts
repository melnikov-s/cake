/**
 * Normalizes a file path mentioned inside a message into a workspace-relative
 * path suitable for project-scoped views such as Browse.
 */
export function toWorkspaceRelativePath(path: string, workspacePath?: string): string {
  let candidate = path.trim().replaceAll("\\", "/");
  if (!candidate) return candidate;
  const workspace = workspacePath?.replaceAll("\\", "/").replace(/\/+$/, "");
  if (workspace && candidate.startsWith(`${workspace}/`))
    candidate = candidate.slice(workspace.length + 1);
  while (candidate.startsWith("./")) candidate = candidate.slice(2);
  return candidate.replace(/^\/+/, "");
}
