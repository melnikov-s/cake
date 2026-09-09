import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionUsage, ToolOutputContent, UiPart } from "../../../ipc/session-contract";
import {
  boundedProjectionKey,
  cakeOperationCommand,
  createLiveMessageProjector,
  formatToolInput,
  formatToolResult,
  projectQueuedMessages,
  textFromContent,
  toolArtifactId,
  toolFilePath,
  toolResultDiff,
  toolResultOutputContent,
} from "./session-projection";
import type { ResponseRetryNotice } from "./response-retry";

export type RuntimeProjectionEvent =
  | { type: "part-updated"; sessionId: string; part: UiPart }
  | { type: "part-removed"; sessionId: string; partId: string }
  | { type: "streaming"; sessionId: string; streaming: boolean }
  | { type: "usage-updated"; sessionId: string; usage: SessionUsage };

export function projectRetryNotice(
  event: ResponseRetryNotice,
): Extract<UiPart, { kind: "notice" }> {
  return {
    id: "active-retry",
    kind: "notice",
    tone: "warning",
    title: `Retry ${event.attempt}/${event.maxAttempts}`,
    detail: event.errorMessage,
    retryAt: Date.now() + event.delayMs,
  };
}

export function activeCompactionNotice(): Extract<UiPart, { kind: "notice" }> {
  return {
    id: "active-compaction",
    kind: "notice",
    tone: "info",
    title: "Compacting context",
  };
}

interface PendingUserPresentation {
  readonly content: string;
  readonly renderUserMessageAsMarkdown: boolean;
  consumed: boolean;
}

export interface RuntimeEventProjection {
  readonly currentUsage: () => SessionUsage;
  readonly queuedParts: () => UiPart[];
  readonly projectEvent: (event: AgentSessionEvent) => void;
  readonly syncQueuedParts: () => void;
  readonly deliverTrackedUserMessage: (
    content: string,
    renderUserMessageAsMarkdown: boolean,
    deliver: () => Promise<void>,
  ) => Promise<void>;
  readonly consumeUserPresentation: (content: string) => PendingUserPresentation | undefined;
  readonly publishUsageUpdate: () => void;
  readonly dispose: () => void;
}

export function createCakeRuntimeEventProjection(input: {
  readonly session: AgentSession;
  readonly sessionId: string;
  readonly emit: (event: RuntimeProjectionEvent) => void;
  readonly compactionQueuedMessages: () => readonly string[];
  readonly isDisposed: () => boolean;
}): RuntimeEventProjection {
  const { session, sessionId, emit } = input;
  const activeToolCalls = new Map<
    string,
    {
      input: string;
      command?: string;
      artifactId?: string;
      filePath?: string;
      diff?: string;
      outputContent?: ToolOutputContent[];
    }
  >();
  const pendingUserPresentations: PendingUserPresentation[] = [];
  const projectLiveMessage = createLiveMessageProjector({
    deferProviderErrors: true,
    renderUserMessageAsMarkdown: (message) => {
      if (typeof message !== "object" || message === null) return false;
      const content = textFromContent(Reflect.get(message, "content"));
      return Boolean(
        pendingUserPresentations.find(
          (candidate) => !candidate.consumed && candidate.content === content,
        )?.renderUserMessageAsMarkdown,
      );
    },
  });
  let usageUpdateTimer: ReturnType<typeof setTimeout> | undefined;
  let lastUsageUpdateAt = 0;

  const currentUsage = (): SessionUsage => {
    const stats = session.getSessionStats();
    return {
      tokens: stats.tokens,
      cost: stats.cost,
      context: stats.contextUsage
        ? {
            tokens: stats.contextUsage.tokens,
            contextWindow: stats.contextUsage.contextWindow,
            percent: stats.contextUsage.percent,
          }
        : undefined,
    };
  };

  const publishUsageUpdate = () => {
    if (usageUpdateTimer !== undefined) {
      clearTimeout(usageUpdateTimer);
      usageUpdateTimer = undefined;
    }
    if (input.isDisposed()) return;
    lastUsageUpdateAt = Date.now();
    emit({ type: "usage-updated", sessionId, usage: currentUsage() });
  };

  const scheduleUsageUpdate = () => {
    if (input.isDisposed() || usageUpdateTimer !== undefined) return;
    const delay = Math.max(0, 250 - (Date.now() - lastUsageUpdateAt));
    if (delay === 0) publishUsageUpdate();
    else usageUpdateTimer = setTimeout(publishUsageUpdate, delay);
  };

  const queuedParts = () =>
    projectQueuedMessages(
      session.getSteeringMessages(),
      session.getFollowUpMessages(),
      input.compactionQueuedMessages(),
    );
  let queuedPartIds = new Set(queuedParts().map((part) => part.id));

  const syncQueuedParts = () => {
    const parts = queuedParts();
    const nextIds = new Set(parts.map((part) => part.id));
    for (const partId of queuedPartIds) {
      if (!nextIds.has(partId)) emit({ type: "part-removed", sessionId, partId });
    }
    for (const part of parts) emit({ type: "part-updated", sessionId, part });
    queuedPartIds = nextIds;
  };

  const deliverTrackedUserMessage = async (
    content: string,
    renderUserMessageAsMarkdown: boolean,
    deliver: () => Promise<void>,
  ) => {
    const pending = { content, renderUserMessageAsMarkdown, consumed: false };
    pendingUserPresentations.push(pending);
    try {
      await deliver();
    } catch (error) {
      if (!pending.consumed) {
        const index = pendingUserPresentations.indexOf(pending);
        if (index >= 0) pendingUserPresentations.splice(index, 1);
      }
      throw error;
    }
  };

  const consumeUserPresentation = (content: string) => {
    const index = pendingUserPresentations.findIndex((candidate) => candidate.content === content);
    const presentation = index >= 0 ? pendingUserPresentations.splice(index, 1)[0] : undefined;
    if (presentation) presentation.consumed = true;
    return presentation;
  };

  const projectEvent = (event: AgentSessionEvent) => {
    if (event.type === "agent_start") emit({ type: "streaming", sessionId, streaming: true });
    for (const part of projectLiveMessage(event)) emit({ type: "part-updated", sessionId, part });

    if (event.type === "message_update" && event.message.role === "assistant") {
      scheduleUsageUpdate();
    }
    if (event.type === "message_end") queueMicrotask(publishUsageUpdate);

    if (event.type === "tool_execution_start") {
      const call = {
        input: formatToolInput(event.toolName, event.args),
        command: event.toolName === "cake" ? cakeOperationCommand(event.args) : undefined,
        artifactId: toolArtifactId(event.args),
        filePath: toolFilePath(event.toolName, event.args),
      };
      activeToolCalls.set(event.toolCallId, call);
      emit({
        type: "part-updated",
        sessionId,
        part: {
          id: boundedProjectionKey(`tool-${event.toolCallId}`),
          kind: "tool",
          name: event.toolName,
          ...call,
          state: "running",
        },
      });
    }
    if (event.type === "tool_execution_update") {
      const call = activeToolCalls.get(event.toolCallId) ?? {
        input: formatToolInput(event.toolName, event.args),
        command: event.toolName === "cake" ? cakeOperationCommand(event.args) : undefined,
        artifactId: toolArtifactId(event.args),
        filePath: toolFilePath(event.toolName, event.args),
        diff: undefined,
      };
      const diff = toolResultDiff(event.toolName, event.partialResult) ?? call.diff;
      const outputContent = toolResultOutputContent(event.partialResult) ?? call.outputContent;
      const nextCall = diff || outputContent ? { ...call, diff, outputContent } : call;
      activeToolCalls.set(event.toolCallId, nextCall);
      emit({
        type: "part-updated",
        sessionId,
        part: {
          id: boundedProjectionKey(`tool-${event.toolCallId}`),
          kind: "tool",
          name: event.toolName,
          ...nextCall,
          output: formatToolResult(event.partialResult),
          state: "running",
        },
      });
    }
    if (event.type === "tool_execution_end") {
      const call = activeToolCalls.get(event.toolCallId);
      activeToolCalls.delete(event.toolCallId);
      emit({
        type: "part-updated",
        sessionId,
        part: {
          id: boundedProjectionKey(`tool-${event.toolCallId}`),
          kind: "tool",
          name: event.toolName,
          command:
            call?.command ??
            (event.toolName === "cake" ? cakeOperationCommand(event.result) : undefined),
          input: call?.input ?? "",
          output: formatToolResult(event.result),
          artifactId: toolArtifactId(event.result) ?? call?.artifactId,
          filePath: call?.filePath,
          diff: toolResultDiff(event.toolName, event.result) ?? call?.diff,
          outputContent: toolResultOutputContent(event.result) ?? call?.outputContent,
          state: event.isError ? "error" : "success",
        },
      });
    }
    if (event.type === "auto_retry_start") {
      for (const partId of projectLiveMessage.takeLastAssistantPartIds())
        emit({ type: "part-removed", sessionId, partId });
      emit({ type: "part-updated", sessionId, part: projectRetryNotice(event) });
    }
    if (event.type === "auto_retry_end")
      emit({ type: "part-removed", sessionId, partId: "active-retry" });

    if (event.type === "compaction_start") {
      const notice = activeCompactionNotice();
      emit({
        type: "part-updated",
        sessionId,
        part: event.reason === "manual" ? notice : { ...notice, detail: event.reason },
      });
    }
    if (event.type === "compaction_end") {
      if (event.aborted) {
        emit({
          type: "part-updated",
          sessionId,
          part: {
            id: "active-compaction",
            kind: "notice",
            tone: "warning",
            title: "Compaction cancelled",
            detail: event.errorMessage,
          },
        });
      } else if (event.errorMessage) {
        emit({
          type: "part-updated",
          sessionId,
          part: {
            id: "active-compaction",
            kind: "notice",
            tone: "error",
            title: "Compaction failed",
            detail: event.errorMessage,
          },
        });
      } else {
        emit({ type: "part-removed", sessionId, partId: "active-compaction" });
      }
    }
    if (event.type === "queue_update") syncQueuedParts();
    if (event.type === "agent_settled") emit({ type: "streaming", sessionId, streaming: false });
  };

  const dispose = () => {
    if (usageUpdateTimer !== undefined) clearTimeout(usageUpdateTimer);
    usageUpdateTimer = undefined;
  };

  return {
    currentUsage,
    queuedParts,
    projectEvent,
    syncQueuedParts,
    deliverTrackedUserMessage,
    consumeUserPresentation,
    publishUsageUpdate,
    dispose,
  };
}
