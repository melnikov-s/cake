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
  toolArtifactRevision,
  toolFilePath,
  toolResultDiff,
  toolResultOutputContent,
} from "./session-projection";
import type { ResponseRetryNotice } from "./response-retry";
import { createNestedToolActivityProjection } from "./nested-tool-activity-projection";
import { projectRuntimeSystemPrompt } from "./system-context-projection";

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

export function createCakeSessionRuntimeEventProjection(input: {
  readonly session: AgentSession;
  readonly sessionId: string;
  readonly emit: (event: RuntimeProjectionEvent) => void;
  readonly compactionQueuedMessages: () => readonly string[];
  readonly queuedParts?: () => UiPart[];
  readonly suppressAbort?: () => boolean;
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
  const nestedActivity = createNestedToolActivityProjection((part) =>
    emit({ type: "part-updated", sessionId, part }),
  );
  const pendingUserPresentations: PendingUserPresentation[] = [];
  let runtimePromptIds = new Set(
    projectRuntimeSystemPrompt(session.systemPrompt).map((part) => part.id),
  );
  const projectLiveMessage = createLiveMessageProjector({
    deferProviderErrors: true,
    suppressAbort: input.suppressAbort,
    currentSystemPrompt: () => session.systemPrompt,
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
  let pendingAssistantUpdate: Extract<AgentSessionEvent, { type: "message_update" }> | undefined;
  let assistantUpdateTimer: ReturnType<typeof setTimeout> | undefined;

  // Pi's message_update carries the complete assistant message accumulated so far. Publishing
  // every token therefore retains and serializes a succession of ever-larger values across the
  // main PubSub and RPC boundary. Keep only the newest superseding update between UI frames.
  const flushAssistantUpdate = () => {
    if (assistantUpdateTimer !== undefined) clearTimeout(assistantUpdateTimer);
    assistantUpdateTimer = undefined;
    const event = pendingAssistantUpdate;
    pendingAssistantUpdate = undefined;
    if (!event || input.isDisposed()) return;
    for (const part of projectLiveMessage(event)) emit({ type: "part-updated", sessionId, part });
  };

  const scheduleAssistantUpdate = (
    event: Extract<AgentSessionEvent, { type: "message_update" }>,
  ) => {
    pendingAssistantUpdate = event;
    if (assistantUpdateTimer !== undefined) return;
    assistantUpdateTimer = setTimeout(flushAssistantUpdate, 50);
  };

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
    input.queuedParts?.() ??
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
    // A queued part's id is derived from its queue, delivery state, and complete
    // encoded content. Existing ids therefore already represent identical parts.
    // Re-emitting every survivor made one removal produce an event storm for the
    // entire queue, repeatedly re-rendering a large queued-prompt list.
    for (const part of parts) {
      if (!queuedPartIds.has(part.id)) emit({ type: "part-updated", sessionId, part });
    }
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
    if (event.type === "agent_start") {
      emit({ type: "streaming", sessionId, streaming: true });
      // before_agent_start extensions may have changed the effective prompt for this run.
      const promptParts = projectRuntimeSystemPrompt(session.systemPrompt);
      const nextIds = new Set(promptParts.map((part) => part.id));
      for (const partId of runtimePromptIds)
        if (!nextIds.has(partId)) emit({ type: "part-removed", sessionId, partId });
      for (const part of promptParts) emit({ type: "part-updated", sessionId, part });
      runtimePromptIds = nextIds;
    }
    if (event.type === "message_update" && event.message.role === "assistant") {
      scheduleAssistantUpdate(event);
      scheduleUsageUpdate();
    } else {
      // A final assistant message supersedes its pending streaming projection. Tool execution
      // first flushes the latest tool-call arguments so ordering remains intuitive.
      if (event.type === "message_end" && event.message.role === "assistant") {
        if (assistantUpdateTimer !== undefined) clearTimeout(assistantUpdateTimer);
        assistantUpdateTimer = undefined;
        pendingAssistantUpdate = undefined;
      } else if (event.type === "tool_execution_start") flushAssistantUpdate();
      for (const part of projectLiveMessage(event)) emit({ type: "part-updated", sessionId, part });
    }

    if (event.type === "message_end") {
      queueMicrotask(publishUsageUpdate);
      if (event.message.role === "toolResult")
        nestedActivity.record(event.message.toolCallId, event.message.nestedCalls);
    }

    if (event.type === "tool_execution_start") {
      const call = {
        input: formatToolInput(event.toolName, event.args),
        command: event.toolName === "cake" ? cakeOperationCommand(event.args) : undefined,
        artifactId: toolArtifactId(event.args),
        filePath: toolFilePath(event.toolName, event.args),
      };
      activeToolCalls.set(event.toolCallId, call);
      nestedActivity.project(
        {
          id: boundedProjectionKey(`tool-${event.toolCallId}`),
          kind: "tool",
          name: event.toolName,
          ...call,
          state: "running",
        },
        event.parentToolCallId,
      );
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
      nestedActivity.project(
        {
          id: boundedProjectionKey(`tool-${event.toolCallId}`),
          kind: "tool",
          name: event.toolName,
          ...nextCall,
          output: formatToolResult(event.partialResult),
          state: "running",
        },
        event.parentToolCallId,
      );
    }
    if (event.type === "tool_execution_end") {
      const call = activeToolCalls.get(event.toolCallId);
      activeToolCalls.delete(event.toolCallId);
      nestedActivity.project(
        {
          id: boundedProjectionKey(`tool-${event.toolCallId}`),
          kind: "tool",
          name: event.toolName,
          command:
            call?.command ??
            (event.toolName === "cake" ? cakeOperationCommand(event.result) : undefined),
          input: call?.input ?? "",
          output: formatToolResult(event.result),
          artifactId: toolArtifactId(event.result) ?? call?.artifactId,
          artifactRevision: toolArtifactRevision(event.result),
          filePath: call?.filePath,
          diff: toolResultDiff(event.toolName, event.result) ?? call?.diff,
          outputContent: toolResultOutputContent(event.result) ?? call?.outputContent,
          state: event.isError ? "error" : "success",
        },
        event.parentToolCallId,
      );
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
    if (event.type === "agent_settled") {
      nestedActivity.settle();
      activeToolCalls.clear();
      emit({ type: "streaming", sessionId, streaming: false });
    }
  };

  const dispose = () => {
    if (usageUpdateTimer !== undefined) clearTimeout(usageUpdateTimer);
    if (assistantUpdateTimer !== undefined) clearTimeout(assistantUpdateTimer);
    usageUpdateTimer = undefined;
    assistantUpdateTimer = undefined;
    pendingAssistantUpdate = undefined;
    activeToolCalls.clear();
    nestedActivity.clear();
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
