import { useState, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import type { UiPart } from "../../../ipc/session-contract";
import { toolOperationName } from "../../../utils/cake-tool";
import { historicalSubagentRuns, type SubagentRun } from "../../../utils/subagent-runs";
import type { SubagentActivityStore } from "../../stores/SubagentActivityStore";
import type { ChatStore } from "../../stores/ChatStore";
import { ChatPopover } from "../message-comment-popover";
import { IconButton } from "../ui/icon-button";
import { ChatIcon } from "../ui/icons";
import { StatusDot } from "../ui/status-dot";

type ToolPart = Extract<UiPart, { kind: "tool" }>;

function currentActivity(run: SubagentRun) {
  const running = [...run.parts]
    .reverse()
    .find(
      (part): part is Extract<UiPart, { kind: "tool" }> =>
        part.kind === "tool" && part.state === "running",
    );
  if (running) return `Running ${running.name}`;
  const latest = [...run.parts]
    .reverse()
    .find((part) => part.kind === "tool" || part.kind === "reasoning");
  if (!latest) return run.status === "queued" ? "Waiting for a worker slot" : undefined;
  return latest.kind === "tool" ? `Last activity: ${latest.name}` : "Reasoning";
}

function modelLabel(run: SubagentRun) {
  const model = run.resolvedModel;
  return model ? `${model.provider}/${model.modelId}` : undefined;
}

export const SubagentTool = observer(function SubagentTool({
  part,
  startPart,
  protocolParts,
  subagents,
  timer,
  renderChat,
}: {
  part: ToolPart;
  startPart?: ToolPart;
  protocolParts?: ToolPart[];
  subagents?: SubagentActivityStore;
  /** Retained for the shared Tool API; subagent detail now lives in the popup chat. */
  live?: boolean;
  timer?: ReactNode;
  expansion?: { open: boolean; toggle(): void };
  renderChat?(store: ChatStore): ReactNode;
}) {
  const [popup, setPopup] = useState<{ key: string; anchor: HTMLElement }>();
  const persistedParts = protocolParts ?? (startPart ? [startPart, part] : [part]);
  const runs = subagents?.runsForTool(part, startPart) ?? historicalSubagentRuns(persistedParts);
  const waitCount = persistedParts.filter(
    (candidate) => toolOperationName(candidate) === "subagents.wait",
  ).length;
  const background = persistedParts.some(
    (candidate) => toolOperationName(candidate) === "subagents.start",
  );
  const foreground = persistedParts.some(
    (candidate) => toolOperationName(candidate) === "subagents.run",
  );
  const automaticallyCompleted = persistedParts.some(
    (candidate) => toolOperationName(candidate) === "subagents.completion",
  );
  const protocolActivity = foreground
    ? "Foreground"
    : background
      ? waitCount > 0
        ? `Background · ${waitCount === 1 ? "waited" : `${waitCount} waits`}`
        : automaticallyCompleted
          ? "Background · notified"
          : "Background"
      : automaticallyCompleted
        ? "Background completion"
        : "Waiting";
  const activeCount = runs.filter(
    (run) => !run.released && (run.status === "queued" || run.status === "running"),
  ).length;
  const completedCount = runs.filter((run) => run.status === "complete").length;
  const popupRun = popup ? runs.find((run) => run.key === popup.key) : undefined;
  const popupChat = popupRun && subagents ? subagents.chatStore(popupRun.key) : undefined;
  const parallel = toolOperationName(part) === "subagents.parallel";

  return (
    <div className="rounded-xl border border-border bg-muted/35 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <StatusDot
          status={
            activeCount > 0
              ? "running"
              : part.state === "success"
                ? "complete"
                : part.state === "error"
                  ? "failed"
                  : part.state === "interrupted"
                    ? "interrupted"
                    : "ready"
          }
        />
        <strong className="font-mono font-semibold">
          {parallel ? "Delegated work" : "Subagent"}
        </strong>
        {timer}
        <span className="ml-auto text-muted-foreground">
          {parallel
            ? `${completedCount}/${runs.length} complete`
            : runs[0]?.released
              ? "released"
              : (runs[0]?.status ?? part.state)}
        </span>
      </div>

      <div className="mt-2 grid gap-1.5" aria-label={parallel ? "Delegated agents" : undefined}>
        {runs.map((run) => {
          const activity = currentActivity(run);
          const released = run.released;
          return (
            <div
              key={run.key}
              data-slot="subagent-call"
              data-status={run.released ? "released" : run.status}
              className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/50 px-2.5 py-2"
            >
              <StatusDot
                status={
                  run.status === "running"
                    ? "running"
                    : run.status === "complete"
                      ? "complete"
                      : run.status === "aborted"
                        ? "interrupted"
                        : run.status === "error"
                          ? "failed"
                          : "pending"
                }
              />
              {parallel && <strong className="shrink-0 font-mono text-xs">Subagent</strong>}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs" title={run.task}>
                  {run.task}
                </p>
                <p className="truncate text-[0.68rem] text-muted-foreground">
                  {[
                    parallel ? undefined : protocolActivity,
                    activity,
                    modelLabel(run),
                    released ? "Released" : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              {subagents && renderChat && (
                <IconButton
                  tooltip="Open subagent chat"
                  aria-label="Open subagent chat"
                  onClick={(event) => setPopup({ key: run.key, anchor: event.currentTarget })}
                >
                  <ChatIcon />
                </IconButton>
              )}
            </div>
          );
        })}
      </div>

      {popup && popupRun && popupChat && renderChat && (
        <ChatPopover
          anchor={popup.anchor}
          title="Subagent"
          eyebrow={popupRun.released ? "Released" : popupRun.status}
          onClose={() => setPopup(undefined)}
        >
          {renderChat(popupChat)}
        </ChatPopover>
      )}
    </div>
  );
});
