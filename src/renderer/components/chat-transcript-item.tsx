import { memo } from "react";
import { TaskSectionRail } from "./task-section-rail";
import { LoadingState } from "@/components/ui/loading-state";
import type { UiPart } from "../../contracts/conversations/session-contract";
import { cn } from "../lib/utils";
import { OriginalHistoryGroup } from "./original-history-group";
import { SideChatImportGroup } from "./side-chat-import-group";
import { ActivityGroup } from "./work-log-activity-group";
import { ReviewRunMessage } from "./chat-transcript-elements";
import { TranscriptPart } from "./chat-transcript-part";
import type { CanonicalTranscriptBehavior } from "./chat-message";
import type { TranscriptItem } from "./chat-transcript-items";

interface ChatTranscriptItemProps {
  /** Stable row identity (the React/Virtuoso key) used for scroll anchoring and reveals. */
  itemKey: string;
  item: TranscriptItem;
  index: number;
  /** Joined the live transcript just now; read on mount only (see memo comparison). */
  arriving: boolean;
  errorFollowsUser: boolean;
  selected: boolean;
  behavior: CanonicalTranscriptBehavior;
  loadingStartedAt: number | undefined;
  loadingLabel: string | undefined;
  taskSection?: { todoId: string | undefined; start: boolean; key: string; expanded: boolean };
}

function sameParts(left: readonly UiPart[], right: readonly UiPart[]) {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function sameItem(left: TranscriptItem, right: TranscriptItem) {
  if (left === right) return true;
  if (left.kind !== right.kind || left.id !== right.id) return false;
  if (left.kind === "original-history" && right.kind === "original-history")
    return sameParts(left.parts, right.parts);
  if (left.kind === "side-chat-import" && right.kind === "side-chat-import")
    return sameParts(left.parts, right.parts);
  if (left.kind === "activity-group" && right.kind === "activity-group")
    return sameParts(left.parts, right.parts);
  if (left.kind === "context-group" && right.kind === "context-group")
    return sameParts(left.parts, right.parts);
  if (left.kind === "source-group" && right.kind === "source-group")
    return sameParts(left.parts, right.parts);
  return left.kind === "loading-state";
}

/** Keeps collection-level streaming updates from re-rendering unchanged transcript items. */
export const ChatTranscriptItem = memo(
  function ChatTranscriptItem({
    itemKey,
    item,
    index,
    arriving,
    errorFollowsUser,
    selected,
    behavior,
    loadingStartedAt,
    loadingLabel,
    taskSection,
  }: ChatTranscriptItemProps) {
    return (
      <div
        data-slot="transcript-item"
        data-transcript-item-index={index}
        data-transcript-item-key={itemKey}
        data-transcript-anchor-id={
          item.kind === "original-history" ||
          item.kind === "side-chat-import" ||
          item.kind === "activity-group" ||
          item.kind === "source-group" ||
          item.kind === "context-group"
            ? item.parts[0]?.id
            : item.id
        }
        aria-current={selected ? "true" : undefined}
        className={cn(
          "relative mx-auto w-full max-w-3xl min-w-0 pb-5 has-[[data-slot=task-section-label]]:grid has-[[data-slot=task-section-label]]:grid-cols-[minmax(0,1fr)] has-[[data-slot=task-section-label]]:pt-8 has-[[data-slot=artifact-disclosure]]:max-w-6xl in-[.chat-layout-compact]:pb-3.5 [&:has([data-slot=artifact-disclosure])_[data-slot=margin-rail]]:hidden [&:has([data-widget-view-id])_[data-slot=margin-rail]]:hidden",
          // Folded task headings are compact list rows, not full message sections.
          taskSection &&
            !taskSection.expanded &&
            "pb-1 has-[[data-slot=task-section-label]]:pt-1 in-[.chat-layout-compact]:pb-1 [&_[data-slot=task-section-label]]:mb-0",
          errorFollowsUser && "pt-3",
          arriving && "motion-safe:animate-arrive",
          // The selection ring outlines only the message bubble, not its label or
          // action row. Items without a bubble (tools, groups) ring the whole item.
          selected &&
            "[&_[data-slot=message-content]]:ring-1 [&_[data-slot=message-content]]:ring-accent/60 [&:not(:has([data-slot=message-content]))]:rounded-md [&:not(:has([data-slot=message-content]))]:ring-1 [&:not(:has([data-slot=message-content]))]:ring-accent/60",
        )}
      >
        {taskSection?.todoId && behavior.todos && (
          <TaskSectionRail
            todoId={taskSection.todoId}
            start={taskSection.start}
            todos={behavior.todos}
            expanded={taskSection.expanded}
            onToggle={() =>
              behavior.todos?.toggleTranscriptSection(taskSection.key, taskSection.todoId!)
            }
          />
        )}
        <div
          hidden={taskSection && !taskSection.expanded}
          className="col-start-1 row-start-2 min-w-0"
        >
          {taskSection && !taskSection.expanded ? null : item.kind === "original-history" ? (
            <OriginalHistoryGroup parts={item.parts} behavior={behavior} />
          ) : item.kind === "side-chat-import" ? (
            <SideChatImportGroup group={item} behavior={behavior} />
          ) : item.kind === "activity-group" ? (
            <ActivityGroup groupId={item.id} parts={item.parts} behavior={behavior} />
          ) : item.kind === "source-group" ? (
            <div className="flex flex-wrap items-center gap-2" data-slot="source-group">
              {item.parts.map((part) => (
                <TranscriptPart key={part.id} part={part} behavior={behavior} />
              ))}
            </div>
          ) : item.kind === "context-group" ? (
            <div className="flex flex-wrap items-start gap-2" data-slot="context-group">
              {item.parts.map((part) => (
                <TranscriptPart key={part.id} part={part} behavior={behavior} />
              ))}
            </div>
          ) : item.kind === "loading-state" ? (
            <LoadingState label={loadingLabel} startedAt={loadingStartedAt} />
          ) : item.kind === "review-run" ? (
            <ReviewRunMessage run={item} onOpen={behavior.onOpenReviewRun} />
          ) : (
            <TranscriptPart part={item} userContent={item.userContent} behavior={behavior} />
          )}
        </div>
      </div>
    );
  },
  // `arriving` is deliberately ignored: it only matters for the mount that starts the
  // entrance, and a later re-render dropping the class must not cut the animation short.
  (previous, next) =>
    previous.taskSection?.todoId === next.taskSection?.todoId &&
    previous.taskSection?.start === next.taskSection?.start &&
    previous.taskSection?.key === next.taskSection?.key &&
    previous.taskSection?.expanded === next.taskSection?.expanded &&
    previous.itemKey === next.itemKey &&
    previous.index === next.index &&
    previous.selected === next.selected &&
    previous.errorFollowsUser === next.errorFollowsUser &&
    previous.behavior === next.behavior &&
    sameItem(previous.item, next.item) &&
    (next.item.kind !== "loading-state" ||
      (previous.loadingStartedAt === next.loadingStartedAt &&
        previous.loadingLabel === next.loadingLabel)),
);
