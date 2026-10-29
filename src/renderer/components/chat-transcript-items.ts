import type { UiPart } from "../../contracts/conversations/session-contract";
import { systemPromptBaselineFirst } from "../../utils/system-prompt-baseline";
import {
  isCompactedWorkLogPart,
  isWorkLogPart,
  workLogGroupKey,
} from "../../utils/work-log-groups";

export type TranscriptItem =
  | UiPart
  | { kind: "activity-group"; id: string; parts: UiPart[] }
  | {
      kind: "side-chat-import";
      id: string;
      parts: UiPart[];
      source: NonNullable<UiPart["sideChatImport"]>;
    }
  | { kind: "source-group"; id: string; parts: Extract<UiPart, { kind: "source" }>[] }
  | { kind: "context-group"; id: string; parts: Extract<UiPart, { kind: "context" }>[] }
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
  let imported: Extract<TranscriptItem, { kind: "side-chat-import" }> | undefined;
  const flushImported = () => {
    if (imported) items.push(imported);
    imported = undefined;
  };
  let activity: UiPart[] = [];
  let activityCompacted: boolean | undefined;
  let activityGroupIndex = 0;
  let sources: Extract<UiPart, { kind: "source" }>[] = [];
  let context: Extract<UiPart, { kind: "context" }>[] = [];
  const flushContext = () => {
    if (context.length === 0) return;
    items.push({ kind: "context-group", id: `context-${context[0]!.id}`, parts: context });
    context = [];
  };
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
  // History paging and restored projections can prepend dialogue to a current baseline.
  // Keep the same invariant for every shared Chat consumer, not just live reduction.
  for (const part of systemPromptBaselineFirst(parts)) {
    if (part.sideChatImport) {
      flushActivity();
      flushSources();
      flushContext();
      if (imported?.source.groupId !== part.sideChatImport.groupId) {
        flushImported();
        imported = {
          kind: "side-chat-import",
          id: `side-chat-import:${part.sideChatImport.groupId}`,
          parts: [],
          source: part.sideChatImport,
        };
      }
      imported!.parts.push(part);
      continue;
    }
    flushImported();
    if (part.kind === "context") {
      flushActivity();
      flushSources();
      context.push(part);
      continue;
    }
    flushContext();
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
  flushContext();
  flushImported();
  return items;
}
