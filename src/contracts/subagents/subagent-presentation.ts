/** Assignment-derived names work for live workers and retained reports alike. */
export function subagentTaskTitle(task?: string): string {
  const title = task?.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ") ?? "";
  if (!title) return "Delegated task";
  return title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title;
}
