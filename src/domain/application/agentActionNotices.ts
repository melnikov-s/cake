import { Effect, Option, Schema } from "effect";
import type { AgentActionNotice } from "../../contracts/application/agent-action-notice";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";

const Result = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.String,
  projectPath: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
  target: Schema.optionalKey(Schema.Struct({ sessionId: Schema.String })),
  targetTitle: Schema.optionalKey(Schema.String),
  messageId: Schema.optionalKey(Schema.String),
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
  const decoded = Schema.decodeUnknownOption(Result)(value);
  if (Option.isNone(decoded)) return;
  const result = decoded.value;
  let notice: Omit<AgentActionNotice, "source"> | undefined;
  if (result.command === "project.settings.update" || result.command === "projects.settings.update")
    notice = {
      message: "Updated Cake Project settings",
      coalesceKey: `project-settings:${result.projectPath}`,
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
