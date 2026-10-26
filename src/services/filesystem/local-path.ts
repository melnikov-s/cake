import { homedir } from "node:os";
import { join } from "node:path";

/** Expands a leading `~` as agents write it in prose; every other path is returned unchanged. */
export function expandHomePath(path: string) {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
