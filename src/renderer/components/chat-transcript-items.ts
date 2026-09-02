import type { UiPart } from "../../ipc/session-contract";
import { isWorkLogPart, workLogGroupKey } from "../../utils/work-log-groups";

export type TranscriptItem =
  | UiPart
  | { kind: "activity-group"; id: string; parts: UiPart[] }
  | { kind: "source-group"; id: string; parts: Extract<UiPart, { kind: "source" }>[] }
  | { kind: "changed-files"; id: string }
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
  let activityGroupIndex = 0;
  let sources: Extract<UiPart, { kind: "source" }>[] = [];
  const flushActivity = () => {
    if (activity.length === 0) return;
    items.push({
      kind: "activity-group",
      id: workLogGroupKey(activityGroupIndex++),
      parts: activity,
    });
    activity = [];
  };
  const flushSources = () => {
    if (sources.length === 0) return;
    items.push({ kind: "source-group", id: `sources-${sources[0]!.id}`, parts: sources });
    sources = [];
  };
  for (const part of parts) {
    if (isWorkLogPart(part)) {
      flushSources();
      activity.push(part);
    } else if (part.kind === "source") {
      flushActivity();
      sources.push(part);
    } else {
      flushActivity();
      flushSources();
      items.push(part);
    }
  }
  flushActivity();
  flushSources();
  return items;
}
