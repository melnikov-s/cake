import type { SourceLocation, SourcePosition, SourceRange } from "../../ipc/source-location";

const DRAW_SOURCE_LINK_ORIGIN = "https://cake.invalid";
const DRAW_SOURCE_LINK_PATH = "/draw/source";
const MAX_POSITION = 10_000_000;
const allowedParameters = new Set(["path", "line", "column", "endLine", "endColumn"]);

export interface DrawSourceLink {
  readonly path: string;
  readonly range?: SourceRange;
}

/** Draw links are always scoped to the current Project Session's Working Directory. */
export function isValidDrawSourcePath(path: string) {
  if (
    path.length === 0 ||
    path.length > 8_192 ||
    path !== path.trim() ||
    path.startsWith("/") ||
    path.includes("\\") ||
    Array.from(path).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    /^[a-z]:/i.test(path)
  )
    return false;
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function positionValue(value: string | null) {
  if (value === null || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value) - 1;
  return Number.isSafeInteger(parsed) && parsed <= MAX_POSITION ? parsed : undefined;
}

function validPosition(position: SourcePosition) {
  return (
    Number.isInteger(position.line) &&
    position.line >= 0 &&
    position.line <= MAX_POSITION &&
    (position.column === undefined ||
      (Number.isInteger(position.column) &&
        position.column >= 0 &&
        position.column <= MAX_POSITION))
  );
}

export function isValidDrawSourceLink(link: DrawSourceLink) {
  if (!isValidDrawSourcePath(link.path)) return false;
  if (!link.range) return true;
  if (!validPosition(link.range.start)) return false;
  const end = link.range.end;
  if (!end || !validPosition(end)) return true;
  return (
    end.line > link.range.start.line ||
    (end.line === link.range.start.line &&
      (end.column === undefined || end.column >= (link.range.start.column ?? 0)))
  );
}

/** Formats the only application-owned URL accepted on Cake Draw elements. */
export function formatDrawSourceLink(link: DrawSourceLink) {
  if (!isValidDrawSourceLink(link)) throw new Error("Invalid Cake Draw source link");
  const url = new URL(DRAW_SOURCE_LINK_PATH, DRAW_SOURCE_LINK_ORIGIN);
  url.searchParams.set("path", link.path);
  if (link.range) {
    url.searchParams.set("line", String(link.range.start.line + 1));
    if (link.range.start.column !== undefined)
      url.searchParams.set("column", String(link.range.start.column + 1));
    if (link.range.end) {
      url.searchParams.set("endLine", String(link.range.end.line + 1));
      if (link.range.end.column !== undefined)
        url.searchParams.set("endColumn", String(link.range.end.column + 1));
    }
  }
  return url.toString();
}

/** Identifies Cake-owned Draw URLs so malformed ones are never opened externally. */
export function isCakeDrawSourceUrl(reference: string) {
  try {
    const url = new URL(reference);
    return url.origin === DRAW_SOURCE_LINK_ORIGIN && url.pathname === DRAW_SOURCE_LINK_PATH;
  } catch {
    return false;
  }
}

/** Parses a Cake Draw URL into a workspace-relative editor location. */
export function parseDrawSourceLink(reference: string): SourceLocation | undefined {
  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    return undefined;
  }
  if (
    url.origin !== DRAW_SOURCE_LINK_ORIGIN ||
    url.pathname !== DRAW_SOURCE_LINK_PATH ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => !allowedParameters.has(key)) ||
    [...allowedParameters].some((key) => url.searchParams.getAll(key).length > 1)
  )
    return undefined;

  const path = url.searchParams.get("path") ?? "";
  const lineValue = url.searchParams.get("line");
  const columnValue = url.searchParams.get("column");
  const endLineValue = url.searchParams.get("endLine");
  const endColumnValue = url.searchParams.get("endColumn");
  if (!isValidDrawSourcePath(path)) return undefined;
  if (!lineValue) {
    if (columnValue || endLineValue || endColumnValue) return undefined;
    return { path };
  }

  const line = positionValue(lineValue);
  const column = columnValue ? positionValue(columnValue) : undefined;
  const endLine = endLineValue ? positionValue(endLineValue) : undefined;
  const endColumn = endColumnValue ? positionValue(endColumnValue) : undefined;
  if (
    line === undefined ||
    (columnValue && column === undefined) ||
    (endLineValue && endLine === undefined) ||
    (endColumnValue && endColumn === undefined) ||
    (endColumnValue && !endLineValue)
  )
    return undefined;
  const link: DrawSourceLink = {
    path,
    range: {
      start: column === undefined ? { line } : { line, column },
      ...(endLine === undefined
        ? null
        : {
            end: endColumn === undefined ? { line: endLine } : { line: endLine, column: endColumn },
          }),
    },
  };
  return isValidDrawSourceLink(link) ? link : undefined;
}
