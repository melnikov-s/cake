import type { SourceLocation, SourceRange } from "../ipc/source-location";

const webReference = /^(?:(?:https?|mailto|file|data|javascript|vscode):|\/\/|#)/i;
const sourcePath = /^(?!\.\.?$)(?:[^\s/:#]+\/)*[^\s/:#]+\.[a-z][a-z0-9._+-]*$/i;
const lineRangeReference = /^L(\d+)(?:-L?(\d+))?$/;

function parseLineRanges(reference: string): SourceRange[] | undefined {
  const parts = reference.split(",");
  if (parts.length > 32) return undefined;
  const ranges: SourceRange[] = [];
  for (const part of parts) {
    const match = lineRangeReference.exec(part);
    if (!match) return undefined;
    const startLine = Number(match[1]) - 1;
    const endLine = Number(match[2] ?? match[1]) - 1;
    if (startLine < 0 || endLine < startLine) return undefined;
    ranges.push({ start: { line: startLine }, end: { line: endLine } });
  }
  return ranges;
}

/** Parses the source-reference forms Cake presents as application-wide links. */
export function parseSourceLocation(reference: string): SourceLocation | undefined {
  const candidate = reference.trim().replace(/^`|`$/g, "");
  if (!candidate || webReference.test(candidate)) return undefined;

  const qualified =
    /^(.*?)(?:\?view=changes(?:&side=(before|after))?)?(#L\d+(?:-L?\d+)?(?:,L\d+(?:-L?\d+)?)*)?$/.exec(
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

  const hashRanges = /^(.*?)#(.+)$/.exec(candidate);
  if (hashRanges) {
    const path = hashRanges[1] ?? "";
    const ranges = parseLineRanges(hashRanges[2] ?? "");
    if (!sourcePath.test(path) || !ranges) return undefined;
    return ranges.length === 1 ? { path, range: ranges[0] } : { path, ranges };
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

function formatLineRange(range: SourceRange) {
  const start = range.start.line + 1;
  const end = range.end?.line;
  return `L${start}${end !== undefined && end !== range.start.line ? `-L${end + 1}` : ""}`;
}

export function formatSourceLocation(location: SourceLocation): string {
  const ranges = location.ranges ?? (location.range ? [location.range] : []);
  const lineRanges = ranges.length > 0 ? `#${ranges.map(formatLineRange).join(",")}` : "";
  if (location.view === "changes") {
    const side = location.side ? `&side=${location.side}` : "";
    return `${location.path}?view=changes${side}${lineRanges}`;
  }
  if (location.ranges) return `${location.path}${lineRanges}`;
  const range = location.range;
  const start = range?.start;
  const end = range?.end;
  if (!start) return location.path;
  if (end && end.line !== start.line) return `${location.path}#${formatLineRange(range)}`;
  const column = start.column === undefined ? "" : `:${start.column + 1}`;
  return `${location.path}:${start.line + 1}${column}`;
}
