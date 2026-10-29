import { Effect, Schema } from "effect";
import { snapshotPromptFiles } from "../../services/filesystem/prompt-files";
import {
  immediateDelivery,
  SessionMessageDeliveryOptions,
} from "../../contracts/conversations/session-message-delivery";
import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import * as cakeChatTargets from "../cake-chats/cakeChatTargets";
import type { AgentControlCaller } from "./agentControl";
import type { BackendAgentInvocation } from "../../contracts/application/backend-agent-control";
import {
  crossSessionContextSnapshot,
  parseCrossSessionMessage,
  type CrossSessionMessageMetadata,
} from "../../contracts/conversations/cross-session-message";
import {
  deriveCrossSessionDeliveryStatus,
  type CoordinationThread,
  type CoordinationMessage,
} from "../../contracts/conversations/cross-session-coordination";
import { SessionCoordination } from "../../services/session-catalogs/SessionCoordination";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import * as metadata from "../project-sessions/projectSessionMetadata";
import * as sessionReferences from "../project-sessions/sessionReferences";
import * as projectSessions from "../project-sessions/projectSessionOperations";
import * as sessionChats from "../conversations/sessionChats";
import { toJsonValue } from "../../utils/to-json-value";

const context = Effect.fn("AgentControl.context")(function* (sessionId: string) {
  const sessions = yield* CakeSessionRuntimes;
  return yield* Effect.scoped(
    sessions.acquireSession(sessionId).pipe(
      Effect.flatMap((handle) => handle.snapshot()),
      Effect.map((snapshot) => crossSessionContextSnapshot(snapshot.usage?.context)),
      Effect.catch(() => Effect.succeed({ usedTokens: null, windowTokens: null })),
    ),
  );
});

const threadView = Effect.fn("AgentControl.threadView")(function* (thread: CoordinationThread) {
  const sessions = yield* CakeSessionRuntimes;
  const coordination = yield* SessionCoordination;
  for (const message of thread.messages) {
    if (message.delivery === "fyi") {
      const notice = (yield* (yield* SessionFamilyStorage).state()).passiveNotices?.find(
        (item) => item.id === message.messageId,
      );
      // The notice marker proves Pi admission, not transcript projection or execution.
      message.status = notice?.delivered ? "accepted" : "deferred";
      continue;
    }
    if (message.status === "failed" || message.status === "canceled") continue;
    const outcome = yield* coordination.outcome(message);
    const current = yield* Effect.scoped(
      sessions.acquireSession(message.targetSessionId).pipe(
        Effect.flatMap((handle) =>
          Effect.gen(function* () {
            return { snapshot: yield* handle.snapshot(), active: yield* handle.currentTurnIds() };
          }),
        ),
        Effect.catch(() => Effect.succeed(undefined)),
      ),
    );
    if (!current) {
      if (outcome)
        message.status = deriveCrossSessionDeliveryStatus(message.delivery, {
          messageState: "missing",
          turnState: outcome,
          assistantResponseProjected: false,
        });
      continue;
    }
    const { snapshot, active } = current;
    const index = snapshot.parts.findIndex(
      (part) => part.kind === "text" && part.crossSession?.messageId === message.messageId,
    );
    const part = snapshot.parts[index];
    message.status = deriveCrossSessionDeliveryStatus(message.delivery, {
      messageState:
        part?.kind === "text" && part.deliveryState ? "queued" : part ? "projected" : "missing",
      turnState: outcome ?? (active.includes(message.turnId) ? "active" : "unknown"),
      assistantResponseProjected:
        index >= 0 &&
        snapshot.parts
          .slice(index + 1)
          .some((part) => part.kind === "text" && part.role === "assistant"),
    });
  }
  const participants = yield* Effect.forEach(thread.participants, (sessionId) =>
    metadata.lookup({ sessionId }).pipe(
      Effect.map((session) => ({
        sessionId,
        title: session.title,
        projectName: session.projectName,
        workingDirectory: session.workingDirectory,
      })),
      Effect.catch(() =>
        Effect.succeed({
          sessionId,
          title: "Session",
          projectName: "Unknown project",
          workingDirectory: "Unknown working directory",
        }),
      ),
    ),
  );
  return {
    threadId: thread.threadId,
    state: thread.state,
    participants,
    messageCount: thread.messages.length,
    maxMessages: thread.maxMessages,
    messages: thread.messages.map((message) => ({ ...message })),
  };
});

export const invoke = Effect.fn("AgentSessionMessaging.invoke")(function* (
  invocation: Extract<
    BackendAgentInvocation,
    { name: "sessions.send" | "sessions.reply" | "sessions.thread" | "sessions.close-thread" }
  >,
  caller: AgentControlCaller,
) {
  if (invocation.name === "sessions.send" || invocation.name === "sessions.reply")
    yield* Schema.decodeUnknownEffect(SessionMessageDeliveryOptions)(invocation.arguments);
  const coordination = yield* SessionCoordination;
  const { name: command, arguments: input } = invocation;
  const text =
    invocation.name === "sessions.send" || invocation.name === "sessions.reply"
      ? invocation.arguments.promptFiles === undefined
        ? invocation.arguments.text
        : yield* snapshotPromptFiles({
            text: invocation.arguments.text,
            promptFiles: invocation.arguments.promptFiles,
            senderSessionId: caller.sessionId,
            workingDirectory: caller.workingDirectory ?? caller.projectPath,
          })
      : "";
  const fail = (error: string) => toJsonValue({ ok: false, command, error });
  let thread =
    invocation.name === "sessions.send"
      ? input.threadId
        ? yield* coordination.get(input.threadId)
        : undefined
      : yield* coordination.find(caller.sessionId, input.threadId);
  if (thread && !thread.participants.includes(caller.sessionId))
    return fail("The calling session is not in that thread.");
  if (input.threadId && !thread) return fail("Cake could not find that session thread.");
  if (invocation.name === "sessions.thread" || invocation.name === "sessions.close-thread") {
    if (!thread) return fail("There is no matching session thread.");
    if (invocation.name === "sessions.close-thread") yield* coordination.close(thread);
    const view = yield* threadView(thread);
    return toJsonValue({
      ok: true,
      command,
      thread: view,
      ...(invocation.name === "sessions.close-thread" ? { status: "closed" } : null),
    });
  }
  if (thread?.state === "closed") return fail("That session thread is closed.");
  const args = invocation.arguments;
  let targetSessionId: string;
  let replyToMessageId = args.replyToMessageId;
  if (invocation.name === "sessions.send") {
    targetSessionId = yield* sessionReferences.resolve(invocation.arguments.sessionId);
    if (
      thread &&
      invocation.arguments.maxMessages !== undefined &&
      invocation.arguments.maxMessages !== thread.maxMessages
    )
      return fail("The existing thread has a different message limit.");
    if (!thread)
      thread = yield* coordination.create(
        caller.sessionId,
        targetSessionId,
        invocation.arguments.maxMessages,
      );
  } else {
    if (!thread) return fail("There is no matching session thread.");
    const target = thread.participants.find((id) => id !== caller.sessionId);
    if (!target) return fail("The thread has no reply target.");
    targetSessionId = target;
    const inbound = [...thread.messages]
      .reverse()
      .filter(
        (message) =>
          message.senderSessionId === target && message.targetSessionId === caller.sessionId,
      );
    if (replyToMessageId && !inbound.some((message) => message.messageId === replyToMessageId))
      return fail("The reply target is not an inbound thread message.");
    replyToMessageId ??= inbound[0]?.messageId;
    if (!replyToMessageId) return fail("There is no matching message to reply to.");
  }
  if (targetSessionId === caller.sessionId)
    return fail("A session thread requires two different sessions.");
  if (!thread.participants.includes(targetSessionId))
    return fail("The target is not in that thread.");
  if (thread.maxMessages !== undefined && thread.messages.length >= thread.maxMessages) {
    yield* coordination.close(thread);
    return fail("That session thread reached its message limit.");
  }
  const chatTarget = isCakeChatSessionId(targetSessionId)
    ? yield* (yield* cakeChatTargets.acquireAvailable(targetSessionId)).snapshot()
    : undefined;
  const target = chatTarget
    ? { workingDirectory: chatTarget.workspacePath, title: "Project Chat" }
    : yield* metadata.lookup({ sessionId: targetSessionId });
  if (!chatTarget) yield* projectSessions.prepareAgentCommand({ sessionId: targetSessionId });
  const status =
    chatTarget ??
    (yield* (yield* CakeSessionRuntimes).currentStatus({
      ...(yield* metadata.findLocation({ sessionId: targetSessionId })),
      sessionId: targetSessionId,
    }));
  const delivery = immediateDelivery(status?.streaming, args.delivery);
  const resultDelivery = delivery === "fyi" ? "ignore" : (args.resultDelivery ?? "notification");
  const expectsResponse = resultDelivery !== "ignore";
  const messageId = crypto.randomUUID();
  const sequence = thread.messages.length + 1;
  const metadataValue: CrossSessionMessageMetadata = {
    version: 1,
    messageId,
    threadId: thread.threadId,
    sequence,
    expectsResponse,
    resultDelivery,
    ...(replyToMessageId ? { replyToMessageId } : null),
    context: yield* context(caller.sessionId),
    sender: {
      sessionId: caller.sessionId,
      title: caller.title,
      kind: caller.kind,
      ...(caller.projectName ? { projectName: caller.projectName } : null),
      ...(caller.workingDirectory ? { workingDirectory: caller.workingDirectory } : null),
    },
    ...(thread.maxMessages !== undefined ? { maxMessages: thread.maxMessages } : null),
  };
  // Reserve before admission. No renderer acknowledgment or retry may duplicate this mutation.
  const message: CoordinationMessage = {
    messageId,
    senderSessionId: caller.sessionId,
    targetSessionId,
    turnId: messageId,
    delivery,
    status: delivery === "fyi" ? "deferred" : delivery === "queue" ? "queued" : "accepted",
  };
  yield* coordination.record(thread, message);
  const inputRefs =
    invocation.name === "sessions.send" ? (invocation.arguments.inputRefs ?? []) : [];
  const turnId = yield* sessionChats
    .deliver(
      {
        sessionId: targetSessionId,
        text,
        renderUserMessageAsMarkdown: false,
        attachments: inputRefs.map((reference) => ({
          kind: "forwarded-input" as const,
          name: "Attachment",
          reference,
        })),
        crossSession: metadataValue,
      },
      delivery === "queue" ? "follow-up" : delivery,
    )
    .pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          Object.assign(message, { status: "failed" });
        }),
      ),
    );
  message.turnId = turnId;
  if (thread.maxMessages !== undefined && sequence >= thread.maxMessages)
    yield* coordination.close(thread);
  const queued =
    delivery === "queue"
      ? yield* sessionChats
          .listQueuedMessages({ sessionId: targetSessionId })
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
      : undefined;
  let queue;
  if (queued)
    for (const [lane, items] of [
      ["steering", queued.steering],
      ["follow-up", queued.followUp],
    ] as const) {
      const index = items.findIndex(
        (content) => parseCrossSessionMessage(content)?.metadata.messageId === messageId,
      );
      if (index >= 0) queue = { lane, position: index + 1, length: items.length };
    }
  return toJsonValue({
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
    resultDelivery,
    ...(replyToMessageId ? { replyToMessageId } : null),
    recipientContext: yield* context(targetSessionId),
    ...(queue ? { queue } : null),
    status: message.status,
    transcriptDelivery: delivery === "fyi" ? "pending" : "unverified",
    execution: delivery === "fyi" ? "not-requested" : "unverified",
  });
});
