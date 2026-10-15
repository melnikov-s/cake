import { memo } from "react";
import { ChangedFiles } from "@/components/changed-files";
import { LoadingState } from "@/components/ui/loading-state";
import type { UiPart } from "../../contracts/conversations/session-contract";
import type { ChatStore } from "../stores/ChatStore";
import { cn } from "../lib/utils";
import { ActivityGroup } from "./work-log-activity-group";
import { ReviewRunMessage } from "./chat-transcript-elements";
import { TranscriptPart } from "./chat-transcript-part";
import type { CanonicalTranscriptBehavior } from "./chat-message";
import type { TranscriptItem } from "./chat-transcript-items";

interface ChatTranscriptItemProps {
  item: TranscriptItem;
  index: number;
  errorFollowsUser: boolean;
  selected: boolean;
  parts: UiPart[];
  behavior: CanonicalTranscriptBehavior;
  changedFilesOpen: boolean;
  loadingStartedAt: number | undefined;
}

function sameParts(left: readonly UiPart[], right: readonly UiPart[]) {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function sameItem(left: TranscriptItem, right: TranscriptItem) {
  if (left === right) return true;
  if (left.kind !== right.kind || left.id !== right.id) return false;
  if (left.kind === "activity-group" && right.kind === "activity-group")
    return sameParts(left.parts, right.parts);
  if (left.kind === "context-group" && right.kind === "context-group")
    return sameParts(left.parts, right.parts);
  if (left.kind === "source-group" && right.kind === "source-group")
    return sameParts(left.parts, right.parts);
  return left.kind === "changed-files" || left.kind === "loading-state";
}

/** Keeps collection-level streaming updates from re-rendering unchanged transcript items. */
export const ChatTranscriptItem = memo(
  function ChatTranscriptItem({
    item,
    index,
    errorFollowsUser,
    selected,
    parts,
    behavior,
    changedFilesOpen,
    loadingStartedAt,
  }: ChatTranscriptItemProps) {
    const store: ChatStore = behavior.store;
    return (
      <div
        data-slot="transcript-item"
        data-transcript-item-index={index}
        data-transcript-anchor-id={
          item.kind === "activity-group" ||
          item.kind === "source-group" ||
          item.kind === "context-group"
            ? item.parts[0]?.id
            : item.id
        }
        aria-current={selected ? "true" : undefined}
        className={cn(
          "min-w-0 pb-5 in-[.chat-layout-compact]:pb-3.5",
          errorFollowsUser && "pt-3",
          // The selection ring outlines only the message bubble, not its label or
          // action row. Items without a bubble (tools, groups) ring the whole item.
          selected &&
            "[&_[data-slot=message-content]]:ring-1 [&_[data-slot=message-content]]:ring-accent/60 [&:not(:has([data-slot=message-content]))]:rounded-md [&:not(:has([data-slot=message-content]))]:ring-1 [&:not(:has([data-slot=message-content]))]:ring-accent/60",
        )}
      >
        {item.kind === "activity-group" ? (
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
        ) : item.kind === "changed-files" ? (
          <ChangedFiles
            parts={parts}
            workspacePath={behavior.workspacePath}
            open={changedFilesOpen}
            onOpenChange={(open) => store.transcriptInteraction.setChangedFilesOpen(open)}
            onOpenFile={
              behavior.openSourceLocation
                ? (path) => behavior.openSourceLocation?.({ path, view: "changes" })
                : undefined
            }
          />
        ) : item.kind === "loading-state" ? (
          <LoadingState startedAt={loadingStartedAt} />
        ) : item.kind === "review-run" ? (
          <ReviewRunMessage run={item} onOpen={behavior.onOpenReviewRun} />
        ) : (
          <TranscriptPart part={item} behavior={behavior} />
        )}
      </div>
    );
  },
  (previous, next) =>
    previous.index === next.index &&
    previous.selected === next.selected &&
    previous.errorFollowsUser === next.errorFollowsUser &&
    previous.behavior === next.behavior &&
    sameItem(previous.item, next.item) &&
    (next.item.kind !== "changed-files" ||
      (previous.parts === next.parts && previous.changedFilesOpen === next.changedFilesOpen)) &&
    (next.item.kind !== "loading-state" || previous.loadingStartedAt === next.loadingStartedAt),
);
