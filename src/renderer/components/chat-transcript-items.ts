import type { UiPart } from "../../ipc/session-contract";
import {
  isCompactedWorkLogPart,
  isWorkLogPart,
  workLogGroupKey,
} from "../../utils/work-log-groups";

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

/**
 * React keys for transcript items. Assistant text prefers its render key so the
 * live streamed message stays mounted when the settled snapshot replaces its
 * stream id with an entry id; duplicate render keys fall back to item ids.
 */
export function transcriptItemKeys(items: readonly TranscriptItem[]): string[] {
  const used = new Set<string>();
  return items.map((item) => {
    const renderKey = item.kind === "text" ? item.renderKey : undefined;
    const key = renderKey && !used.has(renderKey) ? renderKey : item.id;
    used.add(key);
    return key;
  });
}

export function groupTranscriptParts(parts: UiPart[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let activity: UiPart[] = [];
  let activityCompacted: boolean | undefined;
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
    activityCompacted = undefined;
  };
  const flushSources = () => {
    if (sources.length === 0) return;
    items.push({ kind: "source-group", id: `sources-${sources[0]!.id}`, parts: sources });
    sources = [];
  };
  for (const part of parts) {
    if (isWorkLogPart(part)) {
      flushSources();
      const compacted = isCompactedWorkLogPart(part);
      if (activity.length > 0 && compacted !== activityCompacted) flushActivity();
      activityCompacted = compacted;
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
