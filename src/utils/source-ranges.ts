import type { SourceRange } from "../ipc/source-location";
import type { UiPart } from "../ipc/session-contract";
import { toolDiff } from "./turn-diff";

/** Resolves the new-side line blocks represented by Pi's numbered or unified diff. */
export function changedRanges(diff: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  let nextNewLine: number | undefined;
  let blockStart: number | undefined;
  let blockEnd: number | undefined;
  const flush = () => {
    if (blockStart === undefined) return;
    ranges.push({ start: { line: blockStart }, end: { line: blockEnd ?? blockStart } });
    blockStart = undefined;
    blockEnd = undefined;
  };

  for (const line of diff.split("\n")) {
    const numbered = line.match(/^([ +-])\s*(\d+)\s/);
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      flush();
      nextNewLine = Math.max(0, Number(hunk[1]) - 1);
      continue;
    }
    if (numbered && nextNewLine === undefined) {
      const kind = numbered[1];
      const lineNumber = Math.max(0, Number(numbered[2]) - 1);
      if (kind === "+") {
        blockStart ??= lineNumber;
        blockEnd = lineNumber;
      } else if (kind === "-") {
        blockStart ??= lineNumber;
        blockEnd ??= lineNumber;
      } else {
        flush();
      }
      continue;
    }
    if (nextNewLine === undefined || line.startsWith("\\")) continue;
    const kind = line[0];
    if (kind === "+") {
      blockStart ??= nextNewLine;
      blockEnd = nextNewLine;
      nextNewLine += 1;
    } else if (kind === "-") {
      blockStart ??= nextNewLine;
      blockEnd ??= nextNewLine;
    } else {
      flush();
      if (kind === " ") nextNewLine += 1;
    }
  }
  flush();
  return ranges;
}

export function toolSourceRange(part: Extract<UiPart, { kind: "tool" }>) {
  const diff = toolDiff(part);
  if (!diff) return undefined;
  const ranges = changedRanges(diff);
  if (ranges.length === 0) return undefined;
  return {
    start: ranges[0]!.start,
    end: ranges.at(-1)!.end ?? ranges.at(-1)!.start,
  } satisfies SourceRange;
}
