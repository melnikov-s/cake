/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- Standalone sandbox wire parser: embedded via toString, with no module dependencies. */
/** Standalone wire validator, also embedded in the isolated capture host.
 * Do not normalize here: preview must reject exactly the data rejected by live saves.
 */
export function artifactStateWireError(value: unknown): string | undefined {
  const ancestors = new Set<unknown>();
  const visit = (item: unknown, path: string): string | undefined => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object") return `${path} must be JSON (received ${typeof item})`;
    if (ancestors.has(item)) return `${path} contains a circular reference`;
    if (!Array.isArray(item) && Object.prototype.toString.call(item) !== "[object Object]")
      return `${path} must be a JSON object or array`;
    ancestors.add(item);
    const entries = Array.isArray(item) ? Array.from(item.entries()) : Object.entries(item);
    for (const [key, child] of entries) {
      const error = visit(child, `${path}/${key}`);
      if (error) return error;
    }
    ancestors.delete(item);
  };
  return visit(value, "value");
}
