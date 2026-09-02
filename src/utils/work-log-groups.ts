import type { UiPart } from "../ipc/session-contract";

export function isWorkLogPart(part: UiPart): boolean {
  return (part.kind === "tool" && !part.artifactId) || part.kind === "reasoning";
}

export function workLogGroupKey(index: number): string {
  return `activity-${index}`;
}

/** Stable work-log group keys based on transcript order, independent of live part IDs. */
export function workLogGroupKeys(parts: readonly UiPart[]): string[] {
  const keys: string[] = [];
  let insideGroup = false;
  for (const part of parts) {
    if (isWorkLogPart(part)) {
      if (!insideGroup) keys.push(workLogGroupKey(keys.length));
      insideGroup = true;
    } else {
      insideGroup = false;
    }
  }
  return keys;
}
