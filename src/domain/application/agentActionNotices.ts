import { Effect, Option, Schema } from "effect";
import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import type { AgentActionNotice } from "../../contracts/application/agent-action-notice";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";

const SettingChange = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("settings.update"),
  value: Schema.Struct({ key: Schema.String, label: Schema.String }),
});

const Result = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.String,
  projectPath: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
  target: Schema.optionalKey(Schema.Struct({ sessionId: Schema.String })),
  targetTitle: Schema.optionalKey(Schema.String),
  messageId: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  messageNumber: Schema.optionalKey(Schema.Number),
  maxMessages: Schema.optionalKey(Schema.Number),
  status: Schema.optionalKey(Schema.String),
  thread: Schema.optionalKey(
    Schema.Struct({ threadId: Schema.String, messageCount: Schema.Number }),
  ),
});

/** Mutation acknowledgment is backend-owned. Presentation is routed once, best effort,
 * to the caller's bound window, never replayed and never awaited by admission.
 */
export const present = Effect.fn("AgentActionNotices.present")(function* (
  value: JsonValue | undefined,
  source: AgentActionNotice["source"],
) {
  const setting = Schema.decodeUnknownOption(SettingChange)(value);
  const decoded = Schema.decodeUnknownOption(Result)(value);
  if (Option.isNone(decoded)) return;
  const result = decoded.value;
  if (result.status === "deferred") return;
  let notice: Omit<AgentActionNotice, "source"> | undefined;
  if (result.command === "project.settings.update" || result.command === "projects.settings.update")
    notice = {
      message: "Updated Cake Project settings",
      coalesceKey: `project-settings:${result.projectPath}`,
    };
  if (Option.isSome(setting))
    notice = {
      message: `Updated setting “${setting.value.value.label}”`,
      coalesceKey: `setting:${setting.value.value.key}`,
    };
  if (result.label) {
    const action = {
      "session-labels.add": "Added",
      "session-labels.update": "Updated",
      "session-labels.remove": "Removed",
      "session-labels.reorder": "Reordered",
    }[result.command];
    if (action)
      notice = {
        message: `${action} session label “${result.label.name}”`,
        coalesceKey: `label:${result.command.slice("session-labels.".length)}:${result.label.id}`,
      };
  }
  // Scheduling onto the caller's own conversation is something the user asked that
  // conversation to do, so only schedules that reach another target are announced.
  const targetsCaller = result.target?.sessionId === source.sessionId;
  if (source.kind !== "cake-chat") {
    if (
      (result.command === "sessions.send" || result.command === "sessions.reply") &&
      result.target &&
      result.messageId
    )
      notice = {
        message: `${result.status === "queued" ? "Queued" : "Accepted"} message ${result.messageNumber ? `${result.messageNumber}${result.maxMessages ? `/${result.maxMessages}` : ""} for` : "for"} “${result.targetTitle}”`,
        targetSessionId: result.target.sessionId,
        targetKind: "project-session",
        coalesceKey: `send:${result.messageId}:${result.status}`,
      };
    if (
      result.command === "sessions.schedule" &&
      result.target &&
      result.targetTitle &&
      !targetsCaller
    )
      notice = {
        message: `Scheduled a message for “${result.targetTitle}”`,
        targetSessionId: result.target.sessionId,
        targetKind: isCakeChatSessionId(result.target.sessionId) ? "cake-chat" : "project-session",
        coalesceKey: `schedule:${result.target.sessionId}`,
      };
    if (result.command === "sessions.cancel-scheduled" && result.id && !targetsCaller)
      notice = { message: "Cancelled a scheduled message", coalesceKey: `cancel:${result.id}` };
    if (result.command === "sessions.close-thread" && result.thread)
      notice = {
        message: `Closed session exchange after ${result.thread.messageCount} messages`,
        coalesceKey: `thread-close:${result.thread.threadId}`,
      };
  }
  if (!notice) return;
  const coordinator = yield* Effect.serviceOption(RendererRequestCoordinator);
  if (Option.isSome(coordinator))
    yield* coordinator.value.presentAgentAction({ source, ...notice });
});
