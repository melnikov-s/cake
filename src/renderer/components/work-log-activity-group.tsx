import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { observer } from "r-state-tree/react";
import { cn } from "@/lib/utils";
import { diffStats } from "@/components/ai-elements/diff-view";
import { VirtualizedConversation } from "@/components/ai-elements/conversation";
import { WorkLogDiff } from "@/components/ai-elements/work-log-diff";
import { ChevronIcon } from "@/components/ui/icons";
import { StatusDot } from "@/components/ui/status-dot";
import { Badge } from "@/components/ui/badge";
import { formatElapsed } from "@/components/ui/loading-state";
import type { UiPart } from "../../ipc/session-contract";
import { toolDiff, workLogChanges } from "../../utils/turn-diff";
import { combineSubagentWorkLogParts } from "../subagent-work-log";
import type { CanonicalTranscriptBehavior } from "./chat-message";
import { TranscriptPart } from "./chat-transcript-part";

export const ActivityGroup = observer(function ActivityGroup({
  parts,
  behavior,
  isStreaming,
}: {
  parts: UiPart[];
  behavior: CanonicalTranscriptBehavior;
  isStreaming: boolean;
}) {
  const changes = workLogChanges(parts);
  const hasDiff = changes.length > 0;
  const viewMode = behavior.store.workLogViewMode;
  const showDiff = hasDiff && (viewMode === "diff" || viewMode === "auto");
  const groupId = parts[0]?.id ?? "work-log";
  const open = behavior.store.workLogGroupOpen(groupId, hasDiff);
  const [activityStripOpen, setActivityStripOpen] = useState(false);
  const [logElement, setLogElement] = useState<HTMLDivElement | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const attachLog = useCallback((element: HTMLDivElement | null) => {
    logRef.current = element;
    setLogElement(element);
  }, []);
  const logIsAtBottomRef = useRef(true);
  const workLogItems = combineSubagentWorkLogParts(parts);
  const tools = workLogItems.filter(
    (part) => part.kind === "tool" || part.kind === "subagent-work-log",
  ).length;
  const reasoningParts = parts.filter(
    (part): part is Extract<UiPart, { kind: "reasoning" }> => part.kind === "reasoning",
  );
  const reasoningHasContent = reasoningParts.some((part) => Boolean(part.text.trim()));
  const reasoningIsStreaming = reasoningParts.some((part) => part.status === "streaming");
  const toolParts = parts.filter(
    (part): part is Extract<UiPart, { kind: "tool" }> => part.kind === "tool",
  );
  const activityIsRunning =
    reasoningIsStreaming || toolParts.some((part) => part.state === "running");
  const editParts = toolParts.filter((part) => part.name === "edit" && Boolean(toolDiff(part)));
  const editTotals = editParts.reduce(
    (total, part) => {
      const stats = diffStats(toolDiff(part)!);
      return {
        additions: total.additions + stats.additions,
        deletions: total.deletions + stats.deletions,
      };
    },
    { additions: 0, deletions: 0 },
  );
  const label =
    editParts.length > 0
      ? `${editParts.length} ${editParts.length === 1 ? "edit" : "edits"} · +${editTotals.additions} −${editTotals.deletions}`
      : tools === 0
        ? "Reasoning"
        : `${tools} tool ${tools === 1 ? "call" : "calls"}`;
  const activityCountLabel =
    tools === 0
      ? "Reasoning"
      : `${tools} tool ${tools === 1 ? "call" : "calls"}${reasoningHasContent ? " · reasoning" : ""}`;
  const elapsedMs =
    parts.length > 0
      ? behavior.store.workLogElapsedMsRange(parts[0]!.id, parts[parts.length - 1]!.id)
      : undefined;
  const elapsedLabel = elapsedMs !== undefined ? formatElapsed(elapsedMs) : undefined;
  const activityStripLabel = elapsedLabel
    ? `${activityCountLabel} · ${elapsedLabel}`
    : activityCountLabel;
  const activityVersion = JSON.stringify(parts);
  const live = behavior.store.liveWorkPossible;
  const renderWorkLogItem = (item: (typeof workLogItems)[number], omitToolDiff = false) => (
    <div className="min-w-0">
      {item.kind === "subagent-work-log" ? (
        <TranscriptPart
          part={item.result}
          subagentSpawnPart={item.spawn}
          live={live}
          behavior={behavior}
          workLogItem
          omitToolDiff={omitToolDiff}
        />
      ) : (
        <TranscriptPart
          part={item}
          live={live}
          behavior={behavior}
          workLogItem
          omitToolDiff={omitToolDiff}
        />
      )}
    </div>
  );
  useLayoutEffect(() => {
    if (!isStreaming || !open || !logRef.current || !logIsAtBottomRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [activityVersion, isStreaming, open]);
  if (tools === 0 && !reasoningHasContent)
    return (
      <div
        data-slot="activity-group"
        className="flex items-center gap-2 rounded-xl border border-border/80 bg-muted/45 px-3.5 py-2.5 font-mono text-xs font-semibold text-muted-foreground"
        role="status"
      >
        <StatusDot status={activityIsRunning ? "running" : "complete"} />
        {reasoningIsStreaming ? "Thinking…" : "Reasoning details not exposed"}
      </div>
    );
  return (
    <details
      data-slot="activity-group"
      className="overflow-hidden rounded-xl border border-border/80 bg-muted/45"
      open={open}
    >
      <summary
        className="flex cursor-pointer select-none items-center gap-2 px-3.5 py-2.5 font-mono text-xs font-semibold text-foreground [&::-webkit-details-marker]:hidden"
        onClick={(event) => {
          event.preventDefault();
          behavior.store.setWorkLogGroupOpen(groupId, !open);
        }}
      >
        <StatusDot status={activityIsRunning ? "running" : "complete"} />
        <span>Work log</span>
        <small className="ml-1.5 font-normal text-muted-foreground">{label}</small>
      </summary>
      {open && (
        <div
          data-slot="work-log-content"
          className="max-h-[32rem] space-y-2 overflow-y-auto border-t border-border/60 p-3 pt-2.5"
          ref={attachLog}
          onScroll={(event) => {
            const log = event.currentTarget;
            logIsAtBottomRef.current = log.scrollHeight - log.clientHeight - log.scrollTop <= 1;
          }}
        >
          {showDiff ? (
            <div>
              <div className="mb-2 overflow-hidden rounded-lg border border-border bg-card/60">
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-2 text-left font-mono text-xs text-foreground hover:bg-muted/50 transition-colors"
                  aria-expanded={activityStripOpen}
                  onClick={() => setActivityStripOpen((val) => !val)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Badge variant="outline" className="h-4 px-1 text-[9px] font-mono uppercase">
                      Activity
                    </Badge>
                    <span>{activityStripLabel}</span>
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span>{activityStripOpen ? "Hide steps" : "View steps"}</span>
                    <ChevronIcon
                      className={cn(
                        "transition-transform duration-150",
                        activityStripOpen && "-rotate-90",
                      )}
                    />
                  </span>
                </button>
                {activityStripOpen && logElement && (
                  <VirtualizedConversation
                    className="space-y-2 border-t border-border bg-muted/20 p-2.5"
                    customScrollParent={logElement}
                    data={workLogItems}
                    computeItemKey={(_index, item) => item.id}
                    followOutput={isStreaming ? "auto" : false}
                    itemContent={(_index, item) => renderWorkLogItem(item, true)}
                  />
                )}
              </div>
              <WorkLogDiff
                parts={parts}
                streaming={activityIsRunning}
                onOpenSourceLocation={behavior.openSourceLocation}
                workspacePath={behavior.workspacePath}
              />
            </div>
          ) : (
            logElement && (
              <VirtualizedConversation
                className="space-y-2"
                customScrollParent={logElement}
                data={workLogItems}
                computeItemKey={(_index, item) => item.id}
                followOutput={isStreaming ? "auto" : false}
                itemContent={(_index, item) => renderWorkLogItem(item)}
              />
            )
          )}
        </div>
      )}
    </details>
  );
});
