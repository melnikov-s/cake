import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

/** True when a canonical path equals or sits under the canonical root. */
function pathIsInsideRoot(root: string, canonicalPath: string) {
  const pathFromRoot = relative(root, canonicalPath);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`))
  );
}

function realSyncOrUndefined(candidate: string) {
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

/** True when the candidate path, resolved through symlinks, stays inside the canonical root. */
export function canonicalPathIsInsideRoot(root: string, candidate: string) {
  const canonical = realSyncOrUndefined(candidate);
  return canonical !== undefined && pathIsInsideRoot(root, canonical);
}

/** Realpaths the candidate and returns it, or throws when it resolves outside the root. */
export async function requirePathInsideRoot(root: string, candidate: string) {
  const canonical = await realpath(candidate);
  if (!pathIsInsideRoot(root, canonical)) throw new Error("Path is outside the selected project");
  return canonical;
}
