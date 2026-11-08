import type { Context } from "@earendil-works/chord";
import type { EntryId, ToolExecutionApi } from "@earendil-works/pi-durable";
import { Option, Schema } from "effect";

const ModelToolInput = Schema.Struct({
  kind: Schema.Literal("model"),
  assistant: Schema.Int.check(Schema.isGreaterThan(0)),
  callId: Schema.String,
});

/** Resolve only the SDK-owned originating call, never a leaf or a body-supplied ID. */
export async function durableAssistantEntryId(api: ToolExecutionApi, context: Context) {
  const task = await api.getTask(api.taskId, context);
  const source = Schema.decodeUnknownOption(ModelToolInput)(task?.input);
  if (Option.isNone(source) || source.value.callId !== api.callId) return undefined;
  // SAFETY: the SDK model tool input supplies a validated positive integer entry ID.
  const assistant = await api.commit((tx) => tx.entry(source.value.assistant as EntryId), context);
  if (
    assistant?.conversationId !== api.conversationId ||
    !assistant.model?.some(
      (message) =>
        message.role === "assistant" &&
        message.content.some((block) => block.type === "toolCall" && block.id === api.callId),
    )
  )
    return undefined;
  return String(assistant.id);
}
