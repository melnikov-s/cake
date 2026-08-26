import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { observer } from "r-state-tree/react";
import { diffStats } from "@/components/ai-elements/diff-view";
import { VirtualizedConversation } from "@/components/ai-elements/conversation";
import { WorkLogDiff } from "@/components/ai-elements/work-log-diff";
import { ChevronIcon } from "@/components/ui/icons";
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
    <div className="work-log-item">
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
      <div className="activity-group activity-group-status" role="status">
        <span
          className={`work-log-state${activityIsRunning ? " work-log-running" : ""}`}
          aria-label={activityIsRunning ? "working" : "complete"}
        />
        {reasoningIsStreaming ? "Thinking…" : "Reasoning details not exposed"}
      </div>
    );
  return (
    <details className="activity-group" open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          behavior.store.setWorkLogGroupOpen(groupId, !open);
        }}
      >
        <span
          className={`work-log-state${activityIsRunning ? " work-log-running" : ""}`}
          aria-label={activityIsRunning ? "working" : "complete"}
        />
        Work log <small>{label}</small>
      </summary>
      {open && (
        <div
          ref={attachLog}
          onScroll={(event) => {
            const log = event.currentTarget;
            logIsAtBottomRef.current = log.scrollHeight - log.clientHeight - log.scrollTop <= 1;
          }}
        >
          {showDiff ? (
            <div className="work-log-diff-view">
              <div className="work-log-activity-strip">
                <button
                  type="button"
                  className="work-log-activity-strip-toggle"
                  aria-expanded={activityStripOpen}
                  onClick={() => setActivityStripOpen((val) => !val)}
                >
                  <span className="work-log-activity-strip-summary">
                    <span className="work-log-activity-strip-badge">Activity</span>
                    <span>{activityStripLabel}</span>
                  </span>
                  <span className="work-log-activity-strip-action">
                    <span>{activityStripOpen ? "Hide steps" : "View steps"}</span>
                    <ChevronIcon
                      className={`work-log-strip-chevron${activityStripOpen ? " open" : ""}`}
                    />
                  </span>
                </button>
                {activityStripOpen && logElement && (
                  <VirtualizedConversation
                    className="work-log-activity-strip-items"
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
              />
            </div>
          ) : (
            logElement && (
              <VirtualizedConversation
                className="work-log-items"
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
