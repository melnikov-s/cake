import type { UiPart } from "../ipc/session-contract";

export function isWorkLogPart(part: UiPart): boolean {
  return (
    (part.kind === "tool" && !part.artifactId) ||
    part.kind === "reasoning" ||
    (part.kind === "command" && part.origin === "compacted")
  );
}

export function isCompactedWorkLogPart(part: UiPart): boolean {
  return isWorkLogPart(part) && "origin" in part && part.origin === "compacted";
}

export function workLogGroupKey(index: number): string {
  return `activity-${index}`;
}

/** Stable work-log group keys based on transcript order, independent of live part IDs. */
export function workLogGroupKeys(parts: readonly UiPart[]): string[] {
  const keys: string[] = [];
  let groupOrigin: "compacted" | "current" | undefined;
  for (const part of parts) {
    if (isWorkLogPart(part)) {
      const origin = isCompactedWorkLogPart(part) ? "compacted" : "current";
      if (origin !== groupOrigin) keys.push(workLogGroupKey(keys.length));
      groupOrigin = origin;
    } else groupOrigin = undefined;
  }
  return keys;
}
