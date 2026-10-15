import type {
  AppControlHost,
  AgentControlSource,
  AppControlResult,
  AgentActionReceipt,
} from "./app-control-data";

type SuccessfulResult = Extract<AppControlResult, { ok: true }>;

/** Commands whose receipt announces an effect on a session other than the caller. */
const crossSessionCommands = new Set<SuccessfulResult["command"]>([
  "sessions.open",
  "sessions.create",
  "sessions.create-draft",
  "sessions.send",
  "sessions.reply",
  "sessions.close-thread",
  "sessions.compact",
  "sessions.schedule",
  "sessions.cancel-scheduled",
  "sessions.abort",
  "sessions.rename",
  "sessions.set-labels",
]);

/**
 * Cake Chat exists to coordinate other sessions, so its effects on them are
 * expected rather than noteworthy. Receipts for its own session and for app
 * settings still apply.
 */
function isCakeChatCoordination(result: SuccessfulResult, source: AgentControlSource) {
  if (source.kind !== "cake-chat") return false;
  if (result.command === "sessions.resolve")
    return !result.targets.some((target) => target.sessionId === source.sessionId);
  return crossSessionCommands.has(result.command);
}

export function agentActionReceipt(
  host: AppControlHost,
  result: SuccessfulResult,
  source: AgentControlSource,
): AgentActionReceipt | undefined {
  if (isCakeChatCoordination(result, source)) return undefined;
  const projectTitle = (sessionId: string) =>
    host.state.sessions().find((session) => session.sessionId === sessionId)?.title ?? "Session";
  const projectTarget = (sessionId: string) => ({
    targetSessionId: sessionId,
    targetKind: "project-session" as const,
  });
  const resolutionKey = (
    resolved: boolean,
    targets: ReadonlyArray<{
      sessionId: string;
      kind: "project-session" | "cake-chat";
    }>,
  ) =>
    `resolve:${targets.map((target) => `${target.kind}:${target.sessionId}`).join(",")}:${resolved}`;
  const resolutionReceipt = (
    message: string,
    resolved: boolean,
    targets: ReadonlyArray<{
      sessionId: string;
      kind: "project-session" | "cake-chat";
    }>,
    target?: {
      sessionId: string;
      kind: "project-session" | "cake-chat";
    },
  ) => {
    const receipt: AgentActionReceipt = {
      message,
      coalesceKey: resolutionKey(resolved, targets),
    };
    if (target) {
      receipt.targetSessionId = target.sessionId;
      receipt.targetKind = target.kind;
    }
    return receipt;
  };
  if (result.command === "agent.action") {
    const messages = {
      compact: "Compacted this session",
      rename: `Renamed this session${result.detail ? ` to “${result.detail}”` : ""}`,
      resolve: "Resolved this session",
      restore: "Restored this session",
      "set-model": `Changed this session’s model${result.detail ? ` to ${result.detail}` : ""}`,
    } as const;
    return {
      message: messages[result.action],
      targetSessionId: source.sessionId,
      targetKind: source.kind,
      coalesceKey:
        result.action === "resolve" || result.action === "restore"
          ? resolutionKey(result.action === "resolve", [
              { sessionId: source.sessionId, kind: source.kind },
            ])
          : `current:${result.action}:${result.detail ?? ""}`,
    };
  }
  if (result.command === "settings.update")
    return {
      message: `Updated Cake ${result.section} settings`,
      coalesceKey: `settings:${result.section}`,
    };
  if (result.command === "project.settings.update" || result.command === "projects.settings.update")
    return {
      message: "Updated Cake Project settings",
      coalesceKey: `project-settings:${result.projectPath}`,
    };
  if (result.command === "app.split")
    return {
      message: `Split this chat ${result.direction === "right" ? "to the right" : "down"}`,
      targetSessionId: result.sessionId,
      targetKind: result.kind,
      coalesceKey: `split:${result.paneId}`,
    };
  if (result.command === "sessions.open")
    return {
      message: `Opened “${projectTitle(result.opened.sessionId)}”`,
      coalesceKey: `open:${result.opened.sessionId}`,
    };
  if (result.command === "sessions.create")
    return {
      message: `Created and started “${result.title}”`,
      ...projectTarget(result.sessionId),
      coalesceKey: `create:${result.sessionId}`,
    };
  if (result.command === "sessions.create-draft")
    return {
      message: `Created draft “${result.title}”`,
      ...projectTarget(result.sessionId),
      coalesceKey: `draft:${result.sessionId}`,
    };
  if (result.command === "sessions.send" || result.command === "sessions.reply")
    return {
      message: `${result.status === "queued" ? "Queued" : "Accepted"} message ${result.messageNumber ? `${result.messageNumber}${result.maxMessages ? `/${result.maxMessages}` : ""} for` : "for"} “${result.targetTitle}”`,
      ...projectTarget(result.target.sessionId),
      coalesceKey: `send:${result.messageId}:${result.status}`,
    };
  if (result.command === "sessions.close-thread")
    return {
      message: `Closed session exchange after ${result.thread.messageCount} messages`,
      coalesceKey: `thread-close:${result.thread.threadId}`,
    };
  if (result.command === "sessions.compact")
    return {
      message: `Compacted “${projectTitle(result.target.sessionId)}”`,
      ...projectTarget(result.target.sessionId),
      coalesceKey: `compact:${result.target.sessionId}`,
    };
  if (result.command === "sessions.schedule")
    return {
      message: `Scheduled a message for “${projectTitle(result.target.sessionId)}”`,
      ...projectTarget(result.target.sessionId),
      coalesceKey: `schedule:${result.target.sessionId}`,
    };
  if (result.command === "sessions.cancel-scheduled")
    return { message: "Cancelled a scheduled message", coalesceKey: `cancel:${result.id}` };
  if (result.command === "sessions.abort")
    return {
      message: `Stopped “${projectTitle(result.target.sessionId)}”`,
      ...projectTarget(result.target.sessionId),
      coalesceKey: `abort:${result.target.sessionId}`,
    };
  if (result.command === "sessions.rename")
    return {
      message: `Renamed session to “${result.title}”`,
      ...projectTarget(result.target.sessionId),
      coalesceKey: `rename:${result.target.sessionId}`,
    };
  if (result.command === "sessions.set-labels")
    return {
      message:
        result.labels.length > 0
          ? `Labelled “${projectTitle(result.target.sessionId)}” as ${result.labels.map((label) => label.name).join(", ")}`
          : `Cleared the labels from “${projectTitle(result.target.sessionId)}”`,
      ...projectTarget(result.target.sessionId),
      coalesceKey: `label:${result.target.sessionId}`,
    };
  if (result.command === "session-labels.add")
    return {
      message: `Added session label “${result.label.name}”`,
      coalesceKey: `label:add:${result.label.id}`,
    };
  if (result.command === "session-labels.update")
    return {
      message: `Updated session label “${result.label.name}”`,
      coalesceKey: `label:update:${result.label.id}`,
    };
  if (result.command === "session-labels.remove")
    return {
      message: `Removed session label “${result.label.name}”`,
      coalesceKey: `label:remove:${result.label.id}`,
    };
  if (result.command === "session-labels.reorder")
    return {
      message: `Reordered session label “${result.label.name}”`,
      coalesceKey: `label:reorder:${result.label.id}`,
    };
  if (result.command === "sessions.resolve") {
    const target = result.targets.length === 1 ? result.targets[0] : undefined;
    const targets = result.targets.map((item) => ({
      sessionId: item.sessionId,
      kind: item.kind === "cake-chat" ? ("cake-chat" as const) : ("project-session" as const),
    }));
    return resolutionReceipt(
      `${result.resolved ? "Resolved" : "Restored"} ${result.sessionCount} ${result.sessionCount === 1 ? "session" : "sessions"}`,
      result.resolved,
      targets,
      target ? targets[0] : undefined,
    );
  }
  return undefined;
}
