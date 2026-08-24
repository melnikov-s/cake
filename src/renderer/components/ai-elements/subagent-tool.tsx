import { useState, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import type { UiPart } from "../../../ipc/session-contract";
import { historicalSubagentRuns, type SubagentRun } from "../../../utils/subagent-runs";
import type { SubagentActivityStore } from "../../stores/SubagentActivityStore";
import type { ChatStore } from "../../stores/ChatStore";
import { ChatPopover } from "../message-comment-popover";
import { IconButton } from "../ui/icon-button";
import { ChatIcon } from "../ui/icons";

type ToolPart = Extract<UiPart, { kind: "tool" }>;

function toolState(status: SubagentRun["status"]) {
  if (status === "complete") return "success";
  if (status === "aborted") return "interrupted";
  return status;
}

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
  spawnPart,
  subagents,
  timer,
  renderChat,
}: {
  part: ToolPart;
  spawnPart?: ToolPart;
  subagents?: SubagentActivityStore;
  /** Retained for the shared Tool API; subagent detail now lives in the popup chat. */
  live?: boolean;
  timer?: ReactNode;
  expansion?: { open: boolean; toggle(): void };
  renderChat?(store: ChatStore): ReactNode;
}) {
  const [popup, setPopup] = useState<{ key: string; anchor: HTMLElement }>();
  const persistedParts = spawnPart ? [spawnPart, part] : [part];
  const runs = subagents?.runsForTool(part, spawnPart) ?? historicalSubagentRuns(persistedParts);
  const activeCount = runs.filter(
    (run) => !run.released && (run.status === "queued" || run.status === "running"),
  ).length;
  const completedCount = runs.filter((run) => run.status === "complete").length;
  const popupRun = popup ? runs.find((run) => run.key === popup.key) : undefined;
  const popupChat = popupRun && subagents ? subagents.chatStore(popupRun.key) : undefined;
  const parallel = part.name === "subagent_parallel";

  return (
    <div
      className={`tool-call subagent-call rounded-xl border border-border bg-muted/35 px-3 py-2${activeCount > 0 ? " subagent-running" : ""}`}
    >
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span
          className={`tool-state tool-${activeCount > 0 ? "running" : part.state}`}
          aria-label={activeCount > 0 ? "running" : part.state}
        />
        <strong className="font-mono">
          {parallel ? "Delegated work" : `${runs[0]?.profile ?? "worker"} subagent`}
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
              className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/50 px-2.5 py-2"
            >
              <span
                className={`tool-state tool-${toolState(run.status)}`}
                aria-label={released ? "released" : run.status}
              />
              {parallel && <strong className="shrink-0 font-mono text-xs">{run.profile}</strong>}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs" title={run.task}>
                  {run.task}
                </p>
                <p className="truncate text-[0.68rem] text-muted-foreground">
                  {[activity, modelLabel(run), released ? "Released" : undefined]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              {subagents && renderChat && (
                <IconButton
                  tooltip={`Open ${run.profile} subagent chat`}
                  aria-label={`Open ${run.profile} subagent chat`}
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
          title={`${popupRun.profile} subagent`}
          eyebrow={popupRun.released ? "Released" : popupRun.status}
          onClose={() => setPopup(undefined)}
        >
          {renderChat(popupChat)}
        </ChatPopover>
      )}
    </div>
  );
});
