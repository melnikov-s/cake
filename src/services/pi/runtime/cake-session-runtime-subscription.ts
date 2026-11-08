import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import type { CakeSessionRuntimeOptions } from "./cake-session-runtime";
import type { CakeSessionRuntimeTurnController } from "./cake-session-runtime-turn-controller";
import type { CakeSessionRuntimeContinuations } from "./cake-session-runtime-continuations";
import type { RuntimeEventProjection } from "./cake-session-runtime-event-projection";
import type { AbortPresentation } from "./message-projection";
import { internalInputEntryType } from "./internal-input-projection";
import { createTurnResultCapture } from "./turn-result-capture";
import { reportSlowCakeToolExecution } from "./cake-tool-timing";
import {
  turnHandoffEntryType,
  turnStopEntryType,
  userMessagePresentationEntryType,
} from "./session-projection";
import { textFromContent } from "./tool-projection";
import { recoveryInputEntryType } from "./restart-recovery";

/** One Pi listener and its consumption bookkeeping, owned and disposed by the runtime. */
export function createCakeSessionRuntimeSubscription(input: {
  options: CakeSessionRuntimeOptions;
  session: AgentSession;
  turnController: CakeSessionRuntimeTurnController;
  projection: RuntimeEventProjection;
  continuations: CakeSessionRuntimeContinuations;
  isDisposed(): boolean;
  abortPresentation(): AbortPresentation;
  emitSnapshotInBackground(): void;
}) {
  const {
    options,
    session,
    turnController,
    projection,
    continuations,
    abortPresentation,
    emitSnapshotInBackground,
  } = input;
  const cakeSessionId = session.sessionManager.getSessionId();
  let initialTranscriptPublished = !options.newSession;
  let automaticTitleForNextMessage = true;
  const captureTurnResult = createTurnResultCapture(
    () => turnController.executingTurnIds(),
    (turnId, result) => options.onTurnResult?.(turnId, result),
    () =>
      session.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "message" && entry.message.role === "assistant")?.id,
    () => session.model,
  );
  const unsubscribe = session.subscribe((event) => {
    if (input.isDisposed()) return;
    captureTurnResult(event);
    if (event.type === "tool_execution_end") reportSlowCakeToolExecution("pi", event);
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      (event.message.stopReason === "aborted" || event.message.stopReason === "error")
    ) {
      const presentation = abortPresentation();
      // Aborting during a tool makes Pi's follow-up request end as `error` ("This operation
      // was aborted"). Only a handoff claims that ending; a stop keeps today's presentation.
      if (presentation.kind === "handoff")
        session.sessionManager.appendCustomEntry(turnHandoffEntryType, {
          timestamp: event.message.timestamp,
        });
      else if (presentation.kind === "stopped" && event.message.stopReason === "aborted")
        session.sessionManager.appendCustomEntry(turnStopEntryType, {
          timestamp: event.message.timestamp,
          stop: presentation.stop,
        });
    }
    projection.projectEvent(event);
    if (event.type === "session_info_changed" && event.name)
      void options.sessionTitleChanged?.(cakeSessionId, event.name).catch(() => undefined);
    if (event.type === "compaction_end") {
      if (!event.aborted && !event.errorMessage) emitSnapshotInBackground();
      turnController.compactionEnded(event.willRetry);
    }
    if (
      !initialTranscriptPublished &&
      event.type === "message_end" &&
      (event.message.role === "user" || event.message.role === "assistant")
    ) {
      // Pi notifies public listeners before synchronously appending the message.
      // Do not release catalog publication from inside that pre-persistence event.
      queueMicrotask(() => {
        if (input.isDisposed() || initialTranscriptPublished || !session.sessionFile) return;
        if (!existsSync(session.sessionFile)) return;
        initialTranscriptPublished = true;
        options.onInitialTranscriptPersisted?.();
      });
    }
    if (event.type === "message_end" && event.message.role === "user") {
      const content = textFromContent(event.message.content);
      const internal = turnController.internalInput(content);
      if (internal)
        session.sessionManager.appendCustomEntry(internalInputEntryType, {
          timestamp: event.message.timestamp,
          origin: internal,
        });
      const consumedTurnId = turnController.consumeUserMessage(content);
      if (consumedTurnId && !options.ephemeral)
        session.sessionManager.appendCustomEntry(recoveryInputEntryType, {
          turnId: consumedTurnId,
          timestamp: event.message.timestamp,
          // Queue timestamps describe admission; this callback is Pi agent-loop consumption.
          consumedAt: Date.now(),
        });
      const presentation = projection.consumeUserPresentation(content);
      if (presentation?.renderUserMessageAsMarkdown)
        queueMicrotask(() => {
          if (input.isDisposed()) return;
          const target = session.sessionManager
            .getEntries()
            .findLast((entry) => entry.type === "message" && entry.message === event.message);
          if (!target) return;
          session.sessionManager.appendCustomEntry(userMessagePresentationEntryType, {
            targetId: target.id,
            renderAs: "markdown",
          });
          emitSnapshotInBackground();
        });
      const automaticTitle = automaticTitleForNextMessage;
      automaticTitleForNextMessage = true;
      if (!options.auxiliary && !internal)
        void continuations.initializeSessionFromFirstMessage(
          textFromContent(event.message.content),
          automaticTitle,
        );
    }
    if (event.type === "agent_settled" && !turnController.cancellationPending()) {
      turnController.settleTurn();
      void continuations.finishSettledTurn();
    }
  });

  return {
    setAutomaticTitle(enabled: boolean) {
      automaticTitleForNextMessage = enabled;
    },
    dispose: unsubscribe,
  };
}
