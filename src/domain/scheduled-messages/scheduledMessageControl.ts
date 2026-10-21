import { DateTime, Effect, Option } from "effect";
import type { BackendAgentInvocation } from "../../contracts/application/backend-agent-control";
import {
  CAKE_CHAT_SESSION_ID,
  isCakeChatSessionId,
} from "../../contracts/cake-chats/cake-chat-identity";
import {
  agentScheduledPage,
  agentScheduledRead,
  type AgentScheduleInput,
} from "../../contracts/scheduled-messages/agent-scheduled-messages";
import { ScheduledMessages } from "../../services/scheduled-messages/ScheduledMessages";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { toJsonValue } from "../../utils/to-json-value";
import type { AgentControlCaller } from "../application/agentControl";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import * as metadata from "../project-sessions/projectSessionMetadata";
import * as sessionReferences from "../project-sessions/sessionReferences";
import * as scheduledMessages from "./scheduledMessages";

type ScheduledMessageInvocation = Extract<
  BackendAgentInvocation,
  {
    name:
      | "sessions.schedule"
      | "sessions.scheduled"
      | "sessions.scheduled-info"
      | "sessions.cancel-scheduled";
  }
>;

const isoTime = (value: string) => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
};

type ScheduleTiming =
  | { readonly error: string }
  | {
      readonly error?: never;
      readonly sendAt: string;
      readonly repeatEverySeconds?: number;
      readonly repeatUntil?: string;
    };

/** Resolve the first send and optional repeat from agent input against the current time. */
function scheduleTiming(input: AgentScheduleInput, now: number): ScheduleTiming {
  if (input.sendAt !== undefined && input.delaySeconds !== undefined)
    return { error: "Provide sendAt or delaySeconds, not both." };
  if (input.repeatUntil !== undefined && input.repeatEverySeconds === undefined)
    return { error: "repeatUntil requires repeatEverySeconds." };
  const repeatUntil = input.repeatUntil === undefined ? undefined : isoTime(input.repeatUntil);
  if (input.repeatUntil !== undefined && repeatUntil === undefined)
    return { error: "repeatUntil must be an ISO timestamp." };
  let sendAt: string | undefined;
  if (input.sendAt !== undefined) sendAt = isoTime(input.sendAt);
  else if (input.delaySeconds !== undefined)
    sendAt = new Date(now + input.delaySeconds * 1_000).toISOString();
  else if (input.repeatEverySeconds !== undefined)
    sendAt = new Date(now + input.repeatEverySeconds * 1_000).toISOString();
  else return { error: "Provide sendAt, delaySeconds, or repeatEverySeconds." };
  if (sendAt === undefined) return { error: "sendAt must be an ISO timestamp." };
  return {
    sendAt,
    ...(input.repeatEverySeconds === undefined
      ? null
      : { repeatEverySeconds: input.repeatEverySeconds }),
    ...(repeatUntil === undefined ? null : { repeatUntil }),
  };
}

const targetTitle = Effect.fn("ScheduledMessageControl.targetTitle")(function* (sessionId: string) {
  if (sessionId === CAKE_CHAT_SESSION_ID) return "Cake Chat";
  if (isCakeChatSessionId(sessionId)) {
    const project = (yield* ApplicationState)
      .snapshot()
      .projects.find((item) => projectChatSessionId(item.path) === sessionId);
    return project ? `${project.name} / Project Chat` : "Project Chat";
  }
  return yield* metadata.lookup({ sessionId }).pipe(
    Effect.map((session) => session.title),
    Effect.catch(() => Effect.succeed("Session")),
  );
});

/** Backend-owned scheduling controls. Chats and Project Sessions address the same durable
 * schedule; an omitted target means the calling conversation. */
export const invoke = Effect.fn("ScheduledMessageControl.invoke")(
  function* (invocation: ScheduledMessageInvocation, caller: AgentControlCaller) {
    const command = invocation.name;
    const fail = (error: string) => toJsonValue({ ok: false, command, error });
    const service = yield* Effect.serviceOption(ScheduledMessages);
    if (Option.isNone(service)) return fail("Scheduled messages are unavailable.");
    const provide = Effect.provideService(ScheduledMessages, service.value);
    switch (invocation.name) {
      case "sessions.schedule": {
        const input = invocation.arguments;
        const targetSessionId =
          input.sessionId === undefined
            ? caller.sessionId
            : yield* sessionReferences.resolve(input.sessionId);
        const timing = scheduleTiming(input, DateTime.toEpochMillis(yield* DateTime.now));
        if (timing.error !== undefined) return fail(timing.error);
        const message = yield* scheduledMessages
          .schedule({
            targetSessionId,
            text: input.text,
            createdBySessionId: caller.sessionId,
            ...timing,
          })
          .pipe(provide);
        return toJsonValue({
          ok: true,
          command,
          target: { sessionId: targetSessionId },
          targetTitle: yield* targetTitle(targetSessionId),
          scheduledMessage: {
            id: message.id,
            targetSessionId: message.targetSessionId,
            sendAt: message.sendAt,
            ...(message.repeatEverySeconds === undefined
              ? null
              : { repeatEverySeconds: message.repeatEverySeconds }),
            ...(message.repeatUntil === undefined ? null : { repeatUntil: message.repeatUntil }),
          },
          status: "scheduled",
        });
      }
      case "sessions.scheduled": {
        const input = invocation.arguments;
        const sessionId =
          input.sessionId === undefined
            ? undefined
            : yield* sessionReferences.resolve(input.sessionId);
        return toJsonValue({
          ok: true,
          command,
          ...agentScheduledPage(yield* scheduledMessages.list(sessionId).pipe(provide), input),
        });
      }
      case "sessions.scheduled-info": {
        const messages = yield* scheduledMessages.list().pipe(provide);
        return toJsonValue({
          ok: true,
          command,
          message: yield* Effect.try({
            try: () => agentScheduledRead(messages, invocation.arguments),
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          }),
        });
      }
      case "sessions.cancel-scheduled":
        yield* scheduledMessages.cancel(invocation.arguments.id).pipe(provide);
        return toJsonValue({ ok: true, command, id: invocation.arguments.id, status: "cancelled" });
    }
  },
  (effect, invocation) =>
    effect.pipe(
      Effect.catch((cause) =>
        Effect.succeed(
          toJsonValue({
            ok: false,
            command: invocation.name,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        ),
      ),
    ),
);
