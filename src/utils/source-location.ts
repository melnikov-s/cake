import type { SourceLocation } from "../ipc/source-location";

const webReference = /^(?:(?:https?|mailto|file|data|javascript|vscode):|\/\/|#)/i;
const sourcePath = /^(?!\.\.?$)(?:[^\s/:#]+\/)*[^\s/:#]+\.[a-z][a-z0-9._+-]*$/i;

/** Parses the source-reference forms Cake presents as application-wide links. */
export function parseSourceLocation(reference: string): SourceLocation | undefined {
  const candidate = reference.trim().replace(/^`|`$/g, "");
  if (!candidate || webReference.test(candidate)) return undefined;

  const qualified = /^(.*?)(?:\?view=changes(?:&side=(before|after))?)?(#L\d+(?:-L?\d+)?)?$/.exec(
    candidate,
  );
  const diffView = candidate.includes("?view=changes");
  if (diffView) {
    if (!qualified) return undefined;
    const path = qualified[1] ?? "";
    const rangeReference = qualified[3] ?? "";
    if (!sourcePath.test(path)) return undefined;
    const parsed = rangeReference ? parseSourceLocation(`${path}${rangeReference}`) : { path };
    if (!parsed) return undefined;
    return {
      ...parsed,
      view: "changes",
      ...(qualified[2] === "before" || qualified[2] === "after" ? { side: qualified[2] } : null),
    };
  }

  const hashRange = /^(.*?)#L(\d+)(?:-L?(\d+))?$/.exec(candidate);
  if (hashRange) {
    const path = hashRange[1] ?? "";
    if (!sourcePath.test(path)) return undefined;
    const startLine = Number(hashRange[2]) - 1;
    const endLine = Number(hashRange[3] ?? hashRange[2]) - 1;
    if (startLine < 0 || endLine < startLine) return undefined;
    return { path, range: { start: { line: startLine }, end: { line: endLine } } };
  }

  const colonPosition = /^(.*?):(\d+)(?::(\d+))?$/.exec(candidate);
  if (colonPosition) {
    const path = colonPosition[1] ?? "";
    if (!sourcePath.test(path)) return undefined;
    const line = Number(colonPosition[2]) - 1;
    const parsedColumn = colonPosition[3] ? Number(colonPosition[3]) - 1 : undefined;
    if (line < 0 || (parsedColumn !== undefined && parsedColumn < 0)) return undefined;
    return {
      path,
      range: {
        start: parsedColumn === undefined ? { line } : { line, column: parsedColumn },
      },
    };
  }

  return sourcePath.test(candidate) ? { path: candidate } : undefined;
}

export function formatSourceLocation(location: SourceLocation): string {
  const start = location.range?.start;
  const end = location.range?.end;
  if (location.view === "changes") {
    const side = location.side ? `&side=${location.side}` : "";
    const range = start
      ? `#L${start.line + 1}${end && end.line !== start.line ? `-L${end.line + 1}` : ""}`
      : "";
    return `${location.path}?view=changes${side}${range}`;
  }
  if (!start) return location.path;
  if (end && end.line !== start.line) return `${location.path}#L${start.line + 1}-L${end.line + 1}`;
  const column = start.column === undefined ? "" : `:${start.column + 1}`;
  return `${location.path}:${start.line + 1}${column}`;
}
