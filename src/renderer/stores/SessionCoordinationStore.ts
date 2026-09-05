import { Store, observable } from "r-state-tree";
import {
  deriveCrossSessionDeliveryStatus,
  type CoordinationMessage,
  type CoordinationThread,
  type CrossSessionDeliveryProjection,
} from "../../domain/cross-session-coordination";
import type { Session } from "../models/Session";

/**
 * Owns window-scoped, non-authoritative coordination bindings between Project Sessions.
 * Pi remains the authority for every delivered transcript message.
 */
export class SessionCoordinationStore extends Store<{
  sessionById(sessionId: string): Session | undefined;
}> {
  private readonly threads = observable(new Map<string, CoordinationThread>());
  private readonly latestThreadBySession = observable(new Map<string, string>());

  create(sourceSessionId: string, targetSessionId: string, maxMessages?: number) {
    const thread: CoordinationThread = {
      threadId: crypto.randomUUID(),
      participants: [sourceSessionId, targetSessionId],
      messages: [],
      state: "open",
      ...(maxMessages !== undefined ? { maxMessages } : null),
    };
    this.threads.set(thread.threadId, thread);
    return thread;
  }

  get(threadId: string) {
    return this.threads.get(threadId);
  }

  find(sessionId: string, explicitThreadId?: string) {
    const threadId = explicitThreadId ?? this.latestThreadBySession.get(sessionId);
    const thread = threadId ? this.threads.get(threadId) : undefined;
    return thread?.participants.includes(sessionId) ? thread : undefined;
  }

  record(thread: CoordinationThread, message: CoordinationMessage) {
    thread.messages.push(message);
    for (const participant of thread.participants)
      this.latestThreadBySession.set(participant, thread.threadId);
  }

  refresh(thread: CoordinationThread) {
    for (const message of thread.messages) {
      if (message.status === "canceled" || message.status === "failed") continue;
      message.status = deriveCrossSessionDeliveryStatus(
        message.delivery,
        this.deliveryProjection(message),
      );
    }
  }

  close(thread: CoordinationThread) {
    thread.state = "closed";
  }

  private deliveryProjection(message: CoordinationMessage): CrossSessionDeliveryProjection {
    const session = this.props.sessionById(message.targetSessionId);
    if (!session)
      return {
        messageState: "missing",
        turnState: "unknown",
        assistantResponseProjected: false,
      };

    const parts = session.uiParts;
    const messageIndex = parts.findIndex(
      (part) => part.kind === "text" && part.crossSession?.messageId === message.messageId,
    );
    const projectedMessage = messageIndex >= 0 ? parts[messageIndex] : undefined;
    const settledTurn = session.settledTurns.find((turn) => turn.turnId === message.turnId);
    const turnState =
      settledTurn?.outcome ??
      (session.activeTurnIds.includes(message.turnId) ? ("active" as const) : ("unknown" as const));

    return {
      messageState:
        projectedMessage?.kind === "text" && projectedMessage.deliveryState
          ? "queued"
          : projectedMessage
            ? "projected"
            : "missing",
      turnState,
      assistantResponseProjected:
        messageIndex >= 0 &&
        parts
          .slice(messageIndex + 1)
          .some((part) => part.kind === "text" && part.role === "assistant"),
    };
  }
}
