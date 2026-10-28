import { cn } from "../../lib/utils";
import { associationHighlightClassName } from "../ui/nav-item";
import { useContext, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import type { UiPart } from "../../../contracts/conversations/session-contract";
import { toolOperationName } from "../../../utils/cake-tool";
import { historicalSubagentRuns, type SubagentRun } from "../../../utils/subagent-runs";
import type { SubagentActivityStore } from "../../stores/SubagentActivityStore";
import { SideChatContext } from "../side-chat-context";
import { IconButton } from "../ui/icon-button";
import { ChatIcon } from "../ui/icons";
import { StatusDot, statusDotGapClassName } from "../ui/status-dot";

type ToolPart = Extract<UiPart, { kind: "tool" }>;

function currentActivity(run: SubagentRun) {
  const running = [...run.parts]
    .reverse()
    .find(
      (part): part is Extract<UiPart, { kind: "tool" }> =>
        part.kind === "tool" && part.state === "running",
    );
  if (running && run.available) return `Running ${running.name}`;
  const latest = [...run.parts]
    .reverse()
    .find((part) => part.kind === "tool" || part.kind === "reasoning");
  if (!latest)
    return run.available && run.status === "queued" ? "Waiting for a worker slot" : undefined;
  return latest.kind === "tool" ? `Last activity: ${latest.name}` : "Reasoning";
}

function runOutcome(run: SubagentRun) {
  if (run.failurePhase === "start" || (!run.handleId && run.status === "error"))
    return "failed-to-start";
  if (!run.handleId && run.status === "running") return "starting";
  if (!run.available && (run.status === "queued" || run.status === "running")) return "unavailable";
  return run.status;
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
}: {
  part: ToolPart;
  startPart?: ToolPart;
  protocolParts?: ToolPart[];
  subagents?: SubagentActivityStore;
  /** Retained for the shared Tool API; subagent detail now lives in the side chat. */
  live?: boolean;
  timer?: ReactNode;
  expansion?: { open: boolean; toggle(): void };
}) {
  const sideChat = useContext(SideChatContext);
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
    (run) => run.available && (run.status === "queued" || run.status === "running"),
  ).length;
  const completedCount = runs.filter((run) => run.status === "complete").length;
  const parallel = toolOperationName(part) === "subagents.parallel";

  return (
    <div className="rounded-xl border border-border bg-muted/35 px-3 py-2">
      <div className={cn("flex min-w-0 items-center text-xs", statusDotGapClassName)}>
        <StatusDot
          status={
            activeCount > 0
              ? "running"
              : runs.some((run) => run.status === "error")
                ? "failed"
                : runs.some((run) => runOutcome(run) === "unavailable")
                  ? "ready"
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
            : runs[0]
              ? runOutcome(runs[0]).replaceAll("-", " ")
              : part.state}
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
              data-status={runOutcome(run)}
              data-subagent-handle={run.handleId}
              data-associated={subagents?.isAssociated(run.key) ? "true" : undefined}
              className={cn(
                "flex min-w-0 items-center rounded-lg border border-border/60 bg-background/50 px-2.5 py-2",
                statusDotGapClassName,
                subagents?.isAssociated(run.key) && associationHighlightClassName,
              )}
            >
              <StatusDot
                status={
                  !run.available && (run.status === "running" || run.status === "queued")
                    ? "ready"
                    : run.status === "running"
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
                <p className="truncate text-xs text-muted-foreground">
                  {[
                    parallel ? undefined : protocolActivity,
                    activity,
                    modelLabel(run),
                    released ? "Resources released" : undefined,
                    !run.handleId || run.failurePhase === "start"
                      ? run.status === "running"
                        ? "Waiting for the start result"
                        : "No worker was created"
                      : !run.available && run.parts.length === 0
                        ? "Conversation unavailable — see error"
                        : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              {run.error && <p className="text-xs text-destructive">{run.error}</p>}
              {run.handleId && !run.failurePhase && subagents && sideChat && (
                <IconButton
                  tooltip="Open subagent chat"
                  aria-label="Open subagent chat"
                  onClick={() => {
                    const chatStore = subagents.chatStore(run.key);
                    if (!chatStore) return;
                    sideChat.open({
                      key: `subagent:${run.key}`,
                      title: "Subagent",
                      eyebrow: () => {
                        const current = subagents.run(run.key);
                        return `${runOutcome(current ?? run).replaceAll("-", " ")}${current?.released ? " · Resources released" : ""}`;
                      },
                      model: () => subagents.model(run.key),
                      chatStore,
                    });
                  }}
                >
                  <ChatIcon />
                </IconButton>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
