import { Schema } from "effect";
import { gitRevisionSchema, type SourceLocation, type SourceRange } from "../ipc/source-location";

const webReference = /^(?:(?:https?|mailto|file|data|javascript|vscode):|\/\/|#)/i;
const sourcePath = /^(?!\.\.?$)(?:[^\s/:#]+\/)*[^\s/:#]+\.[a-z][a-z0-9._+-]*$/i;
const lineRangeReference = /^L(\d+)(?:-L?(\d+))?$/;
const isGitRevision = Schema.is(gitRevisionSchema);

type ChangesQuery = Pick<SourceLocation, "side" | "base">;

/** Reads `side` and `base` from a `?view=changes&…` query; undefined when any parameter is invalid. */
function parseChangesQuery(query: string): ChangesQuery | undefined {
  let result: ChangesQuery = {};
  if (!query) return result;
  for (const parameter of query.split("&")) {
    const [key, value = ""] = parameter.split("=", 2);
    if (key === "side" && (value === "before" || value === "after") && !result.side)
      result = { ...result, side: value };
    else if (key === "base" && !result.base) {
      const base = safeDecode(value);
      if (base === undefined || !isGitRevision(base)) return undefined;
      result = { ...result, base };
    } else return undefined;
  }
  return result;
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

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

  if (candidate.includes("?view=changes")) {
    const qualified =
      /^(.*?)\?view=changes((?:&[^&#=]+=[^&#]*)*)(#L\d+(?:-L?\d+)?(?:,L\d+(?:-L?\d+)?)*)?$/.exec(
        candidate,
      );
    if (!qualified) return undefined;
    const path = qualified[1] ?? "";
    const query = parseChangesQuery((qualified[2] ?? "").replace(/^&/, ""));
    const rangeReference = qualified[3] ?? "";
    if (!sourcePath.test(path) || !query) return undefined;
    const parsed = rangeReference ? parseSourceLocation(`${path}${rangeReference}`) : { path };
    if (!parsed) return undefined;
    return { ...parsed, view: "changes", ...query };
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
    const base = location.base ? `&base=${encodeURIComponent(location.base)}` : "";
    return `${location.path}?view=changes${side}${base}${lineRanges}`;
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
