import type { UiPart } from "../../ipc/session-contract";

export type TranscriptItem =
  | UiPart
  | { kind: "activity-group"; id: string; parts: UiPart[] }
  | { kind: "loading-state"; id: string };

export function errorNoticeFollowsUser(items: TranscriptItem[], index: number) {
  const item = items[index];
  const previous = items[index - 1];
  return (
    item?.kind === "notice" &&
    item.tone === "error" &&
    ((previous?.kind === "text" && previous.role === "user") || previous?.kind === "skill")
  );
}

export function groupTranscriptParts(parts: UiPart[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let activity: UiPart[] = [];
  const flush = () => {
    if (activity.length === 0) return;
    items.push({ kind: "activity-group", id: `activity-${activity[0]!.id}`, parts: activity });
    activity = [];
  };
  for (const part of parts) {
    if ((part.kind === "tool" && !part.artifactId) || part.kind === "reasoning")
      activity.push(part);
    else {
      flush();
      items.push(part);
    }
  }
  flush();
  return items;
}
