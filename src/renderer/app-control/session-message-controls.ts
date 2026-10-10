import { Effect, Schema } from "effect";
import { inputRefsSchema } from "../../contracts/conversations/task-input";
import { parseCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
import type {
  CoordinationMessage,
  CoordinationThread,
} from "../../contracts/conversations/cross-session-coordination";
import type {
  CrossSessionMessageMetadata,
  CrossSessionContextSnapshot,
  CrossSessionQueueSnapshot,
} from "../../contracts/conversations/cross-session-message";
import { isActiveSessionActivity } from "../lib/session-activity";
import type {
  AppControlHost,
  AgentControlSource,
  AppControlResult,
  CoordinationThreadView,
} from "./app-control-data";
import { knownSession } from "./control-projections";
import { trimmed, sessionIdTargetSchema } from "./control-arguments";
import { defineControl, defineSessionControl } from "./control-definition";
function findThread(host: AppControlHost, sessionId: string, explicitThreadId?: string) {
  return host.sessionCoordination.find(sessionId, explicitThreadId);
}
function contextSnapshot(host: AppControlHost, sessionId: string): CrossSessionContextSnapshot {
  return (
    host.sessions.contextSnapshot?.(sessionId) ?? {
      usedTokens: null,
      windowTokens: null,
    }
  );
}
async function queuedMessageSnapshot(
  host: AppControlHost,
  sessionId: string,
  messageId: string,
): Promise<CrossSessionQueueSnapshot | undefined> {
  try {
    const messages = await host.sessions.listPendingMessages(sessionId);
    for (const [lane, queue] of [
      ["steering", messages.steering],
      ["follow-up", messages.followUp],
    ] as const) {
      const index = queue.findIndex(
        (content) => parseCrossSessionMessage(content)?.metadata.messageId === messageId,
      );
      if (index >= 0) return { lane, position: index + 1, length: queue.length };
    }
  } catch {
    // Queue details are advisory and never turn an accepted send into a failure.
  }
  return undefined;
}
async function sendCrossSessionMessage(
  host: AppControlHost,
  command: "sessions.send" | "sessions.reply",
  targetSessionId: string,
  text: string,
  requestedDelivery: "prompt" | "queue" | "steer" | undefined,
  expectsResponse: boolean,
  replyToMessageId: string | undefined,
  source: AgentControlSource,
  thread: CoordinationThread,
  inputRefs?: readonly string[],
): Promise<AppControlResult> {
  const target = knownSession(host, targetSessionId);
  if (!target)
    return { ok: false, command, error: "Cake could not find the thread's target session." };
  if (targetSessionId === source.sessionId)
    return { ok: false, command, error: "A session thread requires two different sessions." };
  if (thread.maxMessages !== undefined && thread.messages.length >= thread.maxMessages) {
    host.sessionCoordination.close(thread);
    return { ok: false, command, error: "That session thread reached its message limit." };
  }
  const delivery =
    requestedDelivery ??
    (isActiveSessionActivity(host.state.sessionActivity(targetSessionId)) ? "queue" : "prompt");
  const messageId = crypto.randomUUID();
  const sequence = thread.messages.length + 1;
  const metadata: CrossSessionMessageMetadata = {
    version: 1,
    messageId,
    threadId: thread.threadId,
    sequence,
    expectsResponse,
    ...(replyToMessageId ? { replyToMessageId } : null),
    context: contextSnapshot(host, source.sessionId),
    sender: {
      sessionId: source.sessionId,
      title: source.title,
      kind: source.kind,
      ...(source.projectName ? { projectName: source.projectName } : null),
      ...(source.workingDirectory ? { workingDirectory: source.workingDirectory } : null),
    },
    ...(thread.maxMessages !== undefined ? { maxMessages: thread.maxMessages } : null),
  };
  const message: CoordinationMessage = {
    messageId,
    senderSessionId: source.sessionId,
    targetSessionId,
    turnId: messageId,
    delivery,
    status: delivery === "queue" ? "queued" : "accepted",
  };
  // Reserve the sequence before crossing the async boundary so simultaneous
  // participants cannot receive the same message number or exceed the limit.
  host.sessionCoordination.record(thread, message);
  try {
    message.turnId = await host.sessions.sendMessage(
      targetSessionId,
      text,
      delivery === "queue" ? "follow-up" : delivery,
      metadata,
      inputRefs,
    );
  } catch (error) {
    message.status = "failed";
    throw error;
  }
  if (thread.maxMessages !== undefined && sequence >= thread.maxMessages)
    host.sessionCoordination.close(thread);
  const queue =
    message.status === "queued"
      ? await queuedMessageSnapshot(host, targetSessionId, messageId)
      : undefined;
  return {
    ok: true,
    command,
    target: { workspacePath: target.workingDirectory, sessionId: targetSessionId },
    targetTitle: target.title,
    messageId,
    threadId: thread.threadId,
    messageNumber: sequence,
    maxMessages: thread.maxMessages,
    delivery,
    expectsResponse,
    ...(replyToMessageId ? { replyToMessageId } : null),
    recipientContext: contextSnapshot(host, targetSessionId),
    ...(queue ? { queue } : null),
    status: message.status,
  };
}
function threadView(host: AppControlHost, thread: CoordinationThread): CoordinationThreadView {
  host.sessionCoordination.refresh(thread);
  const participants = thread.participants.map((sessionId) => {
    const session = knownSession(host, sessionId);
    return {
      sessionId,
      title: session?.title ?? "Session",
      projectName: session?.projectName ?? "Unknown project",
      workingDirectory: session?.workingDirectory ?? "Unknown working directory",
    };
  });
  return {
    threadId: thread.threadId,
    state: thread.state,
    participants,
    messageCount: thread.messages.length,
    maxMessages: thread.maxMessages,
    messages: thread.messages.map((message) => ({ ...message })),
  };
}
export const sessionMessageControls = [
  defineSessionControl({
    command: "sessions.send",
    args: Schema.Struct({
      inputRefs: Schema.optionalKey(inputRefsSchema),
      ...sessionIdTargetSchema.fields,
      text: trimmed(1, 100000),
      delivery: Schema.optionalKey(Schema.Literals(["prompt", "queue", "steer"])),
      threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
      maxMessages: Schema.optionalKey(
        Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000)),
      ),
      expectsResponse: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
      replyToMessageId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Send, queue, or steer a correlated message to one explicitly targeted session. The result is a visible delivery receipt; optional maxMessages bounds the exchange.",
    },
    run: async (input, { host, source }, command, known): Promise<AppControlResult> => {
      const { sessionId } = input;

      const workspacePath = known.workingDirectory;
      const target = { workspacePath, sessionId };
      if (!source) {
        const delivery =
          input.delivery ??
          (isActiveSessionActivity(host.state.sessionActivity(sessionId)) ? "queue" : "prompt");
        const turnId = await host.sessions.sendMessage(
          sessionId,
          input.text,
          delivery === "queue" ? "follow-up" : delivery,
          undefined,
          input.inputRefs,
        );
        return {
          ok: true,
          command,
          target,
          targetTitle: known.title,
          messageId: turnId,
          delivery,
          expectsResponse: input.expectsResponse,
          recipientContext: contextSnapshot(host, sessionId),
          status: delivery === "queue" ? "queued" : "accepted",
        };
      }
      let thread = input.threadId ? host.sessionCoordination.get(input.threadId) : undefined;
      if (input.threadId && !thread)
        return { ok: false, command, error: "Cake could not find that session thread." };
      if (thread && !thread.participants.includes(source.sessionId))
        return { ok: false, command, error: "The calling session is not in that thread." };
      if (thread?.state === "closed")
        return { ok: false, command, error: "That session thread is closed." };
      if (thread && input.maxMessages !== undefined && input.maxMessages !== thread.maxMessages)
        return {
          ok: false,
          command,
          error: "The existing thread has a different message limit.",
        };
      if (!thread) {
        thread = host.sessionCoordination.create(source.sessionId, sessionId, input.maxMessages);
      }
      if (!thread.participants.includes(sessionId))
        return { ok: false, command, error: "The target is not in that thread." };
      return sendCrossSessionMessage(
        host,
        command,
        sessionId,
        input.text,
        input.delivery,
        input.expectsResponse,
        input.replyToMessageId,
        source,
        thread,
        input.inputRefs,
      );
    },
  }),
  defineControl({
    command: "sessions.reply",
    args: Schema.Struct({
      text: trimmed(1, 100000),
      delivery: Schema.optionalKey(Schema.Literals(["prompt", "queue", "steer"])),
      threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
      expectsResponse: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
      replyToMessageId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Reply to the originating session in the current open coordination thread without supplying a session ID.",
    },
    run: async (input, { host, source }, command): Promise<AppControlResult> => {
      if (!source) return { ok: false, command, error: "Reply requires a calling session." };
      const thread = findThread(host, source.sessionId, input.threadId);
      if (!thread) return { ok: false, command, error: "There is no matching session thread." };
      if (thread.state === "closed")
        return { ok: false, command, error: "That session thread is closed." };
      const targetSessionId = thread.participants.find((id) => id !== source.sessionId);
      if (!targetSessionId) return { ok: false, command, error: "The thread has no reply target." };
      const inboundMessages = [...thread.messages]
        .reverse()
        .filter(
          (message) =>
            message.senderSessionId === targetSessionId &&
            message.targetSessionId === source.sessionId,
        );
      const replyToMessageId = input.replyToMessageId ?? inboundMessages[0]?.messageId;
      if (
        input.replyToMessageId &&
        !inboundMessages.some((message) => message.messageId === input.replyToMessageId)
      )
        return { ok: false, command, error: "The reply target is not an inbound thread message." };
      if (!replyToMessageId)
        return { ok: false, command, error: "There is no matching message to reply to." };
      return sendCrossSessionMessage(
        host,
        command,
        targetSessionId,
        input.text,
        input.delivery,
        input.expectsResponse,
        replyToMessageId,
        source,
        thread,
      );
    },
  }),
  defineControl({
    command: "sessions.thread",
    args: Schema.Struct({
      threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Inspect the current coordination thread, correlated messages, delivery states, participants, and optional message limit.",
    },
    run: async (input, { host, source }, command): Promise<AppControlResult> => {
      if (!source)
        return { ok: false, command, error: "Thread access requires a calling session." };
      const thread = findThread(host, source.sessionId, input.threadId);
      if (!thread) return { ok: false, command, error: "There is no matching session thread." };
      const view = threadView(host, thread);
      return { ok: true, command, thread: view };
    },
  }),
  defineControl({
    command: "sessions.close-thread",
    args: Schema.Struct({
      threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Close the current coordination thread. Further replies are rejected; late arrivals remain attributed to the closed exchange.",
    },
    run: async (input, { host, source }, command): Promise<AppControlResult> => {
      if (!source)
        return { ok: false, command, error: "Thread access requires a calling session." };
      const thread = findThread(host, source.sessionId, input.threadId);
      if (!thread) return { ok: false, command, error: "There is no matching session thread." };
      host.sessionCoordination.close(thread);
      const view = threadView(host, thread);
      return { ok: true, command, thread: view, status: "closed" };
    },
  }),
];
