/** Mirrors Pi's documented list semantics for the global setting, not a session capability claim. */
export function nativeToolSelected(selection: readonly string[] | null, name: string): boolean {
  const entries = selection ?? ["read", "bash", "edit", "write"];
  const plain = entries.filter((entry) => !entry.startsWith("+") && !entry.startsWith("-"));
  const active = new Set(
    plain.length ? plain : entries.length === 0 ? [] : ["read", "bash", "edit", "write"],
  );
  for (const entry of entries) {
    if (entry.startsWith("+")) active.add(entry.slice(1));
    else if (entry.startsWith("-")) active.delete(entry.slice(1));
  }
  return active.has(name);
}

export function updateNativeToolSelection(
  selection: readonly string[] | null,
  name: string,
  enabled: boolean,
): string[] {
  // Keep plain entries: removing the last plain name would accidentally switch
  // an explicit selection back to inherited defaults. Only replace its +/- directives.
  const entries = (selection ?? []).filter((entry) => entry !== `+${name}` && entry !== `-${name}`);
  // An explicitly empty list disables all tools; retain that basis when adding one.
  if (selection?.length === 0 && enabled) return [name];
  if (selection?.length === 0 && !enabled) return [];
  return [...entries, `${enabled ? "+" : "-"}${name}`];
}
