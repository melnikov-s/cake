import { useCallback, useMemo, useState } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { observer } from "r-state-tree/react";
import { diffStats } from "@/components/ai-elements/diff-view";
import { VirtualizedConversation } from "@/components/ai-elements/conversation";
import { WorkLogDiff } from "@/components/ai-elements/work-log-diff";
import { StatusDot } from "@/components/ui/status-dot";
import { WorkLogActivityTrigger } from "@/components/work-log-activity-trigger";
import { cn } from "@/lib/utils";
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
  const changes = useMemo(() => workLogChanges(parts), [parts]);
  const hasDiff = changes.length > 0;
  const viewMode = behavior.store.workLogViewMode;
  const showDiff = hasDiff && (viewMode === "diff" || viewMode === "auto");
  const open = behavior.store.workLogGroupOpen(groupId, hasDiff);
  const [activityStripOpen, setActivityStripOpen] = useState(false);
  const [logElement, setLogElement] = useState<HTMLDivElement | null>(null);
  const { scrollRef, contentRef, stopScroll } = useStickToBottom({
    initial: "instant",
    resize: "instant",
  });
  const attachLog = useCallback(
    (element: HTMLDivElement | null) => {
      scrollRef(element);
      setLogElement(element);
    },
    [scrollRef],
  );
  const workLogItems = useMemo(() => combineSubagentWorkLogParts(parts), [parts]);
  const tools = useMemo(
    () =>
      workLogItems.filter((part) => part.kind === "tool" || part.kind === "subagent-work-log")
        .length,
    [workLogItems],
  );
  const reasoningParts = parts.filter(
    (part): part is Extract<UiPart, { kind: "reasoning" }> => part.kind === "reasoning",
  );
  const reasoningHasContent = reasoningParts.some((part) => Boolean(part.text.trim()));
  const reasoningIsStreaming = reasoningParts.some((part) => part.status === "streaming");
  const toolParts = useMemo(
    () => parts.filter((part): part is Extract<UiPart, { kind: "tool" }> => part.kind === "tool"),
    [parts],
  );
  const activityIsRunning =
    reasoningIsStreaming || toolParts.some((part) => part.state === "running");
  const { editCount, editTotals } = useMemo(() => {
    const editParts = toolParts.filter((part) => part.name === "edit" && Boolean(toolDiff(part)));
    return {
      editCount: editParts.length,
      editTotals: editParts.reduce(
        (total, part) => {
          const stats = diffStats(toolDiff(part)!);
          return {
            additions: total.additions + stats.additions,
            deletions: total.deletions + stats.deletions,
          };
        },
        { additions: 0, deletions: 0 },
      ),
    };
  }, [toolParts]);
  const label =
    editCount > 0
      ? `${editCount} ${editCount === 1 ? "edit" : "edits"} · +${editTotals.additions} −${editTotals.deletions}`
      : tools === 0
        ? "Reasoning"
        : `${tools} tool ${tools === 1 ? "call" : "calls"}`;
  const activityCountLabel =
    tools === 0
      ? "Reasoning"
      : `${tools} tool ${tools === 1 ? "call" : "calls"}${reasoningHasContent ? " · reasoning" : ""}`;
  const firstPartId = parts[0]?.id;
  const lastPartId = parts.at(-1)?.id;
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
          <div ref={contentRef} className="min-w-0">
            {showDiff ? (
              <>
                <div className="sticky top-0 z-1 overflow-hidden border-b border-border bg-card">
                  <WorkLogActivityTrigger
                    store={behavior.store}
                    firstPartId={firstPartId}
                    lastPartId={lastPartId}
                    activityCountLabel={activityCountLabel}
                    open={activityStripOpen}
                    onToggle={() => {
                      if (activityStripOpen) {
                        setActivityStripOpen(false);
                        return;
                      }
                      setActivityStripOpen(true);
                      stopScroll();
                      scrollRef.current?.scrollTo({ top: 0 });
                    }}
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
              </>
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
        </div>
      )}
    </details>
  );
});
