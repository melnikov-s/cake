import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { observer } from "r-state-tree/react";
import { diffStats } from "@/components/ai-elements/diff-view";
import { VirtualizedConversation } from "@/components/ai-elements/conversation";
import { WorkLogDiff } from "@/components/ai-elements/work-log-diff";
import { StatusDot } from "@/components/ui/status-dot";
import { Badge } from "@/components/ui/badge";
import { DisclosureTrigger } from "@/components/ui/disclosure-trigger";
import { formatElapsed } from "@/components/ui/loading-state";
import { cn } from "@/lib/utils";
import { BottomFollowController } from "../lib/bottom-follow-controller";
import type { UiPart } from "../../ipc/session-contract";
import { toolDiff, workLogChanges } from "../../utils/turn-diff";
import { combineSubagentWorkLogParts } from "../subagent-work-log";
import type { CanonicalTranscriptBehavior } from "./chat-message";
import { TranscriptPart } from "./chat-transcript-part";

export const ActivityGroup = observer(function ActivityGroup({
  groupId,
  parts,
  behavior,
}: {
  groupId: string;
  parts: UiPart[];
  behavior: CanonicalTranscriptBehavior;
}) {
  const changes = workLogChanges(parts);
  const hasDiff = changes.length > 0;
  const viewMode = behavior.store.workLogViewMode;
  const showDiff = hasDiff && (viewMode === "diff" || viewMode === "auto");
  const open = behavior.store.workLogGroupOpen(groupId, hasDiff);
  const [activityStripOpen, setActivityStripOpen] = useState(false);
  const [logElement, setLogElement] = useState<HTMLDivElement | null>(null);
  const activityVersion = JSON.stringify(parts);
  const logRef = useRef<HTMLDivElement>(null);
  const scrollController = useMemo(() => new BottomFollowController(), [groupId]);
  const attachLog = useCallback(
    (element: HTMLDivElement | null) => {
      logRef.current = element;
      setLogElement(element);
      scrollController.connectScroller(element ?? undefined);
    },
    [scrollController],
  );
  useEffect(() => () => scrollController.dispose(), [scrollController]);
  useLayoutEffect(() => {
    scrollController.setAlignBottom(() => {
      const log = logRef.current;
      if (open && log) log.scrollTop = log.scrollHeight;
    });
    scrollController.layoutChanged();
    return () => scrollController.setAlignBottom(undefined);
  }, [activityVersion, open, scrollController]);
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
  const live = behavior.store.liveWorkPossible;
  const renderWorkLogItem = (item: (typeof workLogItems)[number], omitToolDiff = false) => (
    <div className="min-w-0">
      {item.kind === "subagent-work-log" ? (
        <TranscriptPart
          part={item.latest}
          subagentParts={item.parts}
          subagentStartPart={item.start}
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
          className={cn(
            "max-h-[32rem] overflow-y-auto border-t border-border/60",
            showDiff ? "p-0" : "p-3 pt-2.5",
          )}
          ref={attachLog}
        >
          {showDiff ? (
            <div>
              <div className="sticky top-0 z-20 overflow-hidden border-b border-border bg-card">
                <DisclosureTrigger
                  className="px-3 py-2 hover:bg-muted/50"
                  open={activityStripOpen}
                  onClick={() => setActivityStripOpen((val) => !val)}
                  badge={
                    <Badge variant="outline" size="xs" className="text-muted-foreground">
                      Activity
                    </Badge>
                  }
                  title={activityStripLabel}
                  trailing={
                    <span className="text-[11px] text-muted-foreground">
                      {activityStripOpen ? "Hide steps" : "View steps"}
                    </span>
                  }
                />
              </div>
              {activityStripOpen && logElement && (
                <VirtualizedConversation
                  className="space-y-2 border-b border-border bg-muted/20 p-2.5"
                  customScrollParent={logElement}
                  data={workLogItems}
                  computeItemKey={(_index, item) => item.id}
                  followOutput={false}
                  itemContent={(_index, item) => renderWorkLogItem(item, true)}
                />
              )}
              <WorkLogDiff
                parts={parts}
                streaming={activityIsRunning}
                onOpenSourceLocation={behavior.openSourceLocation}
                workspacePath={behavior.workspacePath}
                changeClassName="rounded-none border-x-0 border-t-0 last:border-b-0"
                headerClassName="top-[33px] bg-card"
              />
            </div>
          ) : (
            logElement && (
              <VirtualizedConversation
                className="space-y-2"
                customScrollParent={logElement}
                data={workLogItems}
                computeItemKey={(_index, item) => item.id}
                followOutput={false}
                itemContent={(_index, item) => renderWorkLogItem(item)}
              />
            )
          )}
        </div>
      )}
    </details>
  );
});
