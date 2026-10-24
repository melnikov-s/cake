/** Shorten only the actual home directory, never a similarly prefixed directory. */
export function toHomeRelativePath(path: string, homeDirectory?: string): string {
  const home = homeDirectory?.replace(/\/+$/, "");
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
