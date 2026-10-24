import type { Context } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import type { EntryId, ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { Option, Schema } from "effect";
import type { CakeOperationHost } from "../../contracts/agent/cake-operation-context";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import { InterviewEntry, InterviewResult } from "../../contracts/interviews/interview";
import type { UiPart } from "../../contracts/conversations/session-contract";
import { CakeOperationRegistry } from "../pi/runtime/cake-operation-registry";

const ModelToolInput = Schema.Struct({
  kind: Schema.Literal("model"),
  assistant: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  callId: Schema.String,
});
const InterviewDetails = Schema.Struct({ interview: InterviewEntry });

/** The SDK live slot and final tool-result details are the sole persisted interview metadata. */
export function durableToolInterview(details: unknown, callId: string) {
  const decoded = Schema.decodeUnknownOption(InterviewDetails)(details);
  if (Option.isNone(decoded)) return undefined;
  const entry = decoded.value.interview;
  return entry.id === callId && entry.origin.toolCallId === callId ? entry : undefined;
}

export function withDurableToolInterview(part: UiPart, entry: InterviewEntry | undefined): UiPart {
  if (part.kind !== "tool" || !entry) return part;
  const result = Schema.decodeUnknownOption(Schema.fromJsonString(InterviewResult))(
    part.output ?? "",
  );
  return {
    ...part,
    interview: { id: entry.id, sessionId: entry.sessionId, request: entry.request },
    ...(Option.isSome(result) && result.value.interviewId === entry.id
      ? { interviewResult: result.value }
      : null),
  };
}

/** Composition supplies only the shared interview operation, never parent Cake authority. */
export function createDurableSideChatInterview(
  sessionId: string,
  operations: (bridge: {
    host: CakeOperationHost;
    publishSnapshot(): Promise<void>;
  }) => CakeOperationDefinition[],
) {
  return async (
    input: unknown,
    api: ToolExecutionApi,
    context: Context,
  ): Promise<ToolExecutionResult> => {
    const task = await api.getTask(api.taskId, context);
    const source = Schema.decodeUnknownOption(ModelToolInput)(task?.input);
    if (Option.isNone(source) || source.value.callId !== api.callId)
      throw new Error("An interview requires its originating assistant tool call");
    // SAFETY: the SDK model tool input supplies a validated nonnegative integer entry ID.
    const assistant = await api.commit(
      (tx) => tx.entry(source.value.assistant as EntryId),
      context,
    );
    if (
      !assistant?.model?.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some((block) => block.type === "toolCall" && block.id === api.callId),
      )
    )
      throw new Error("An interview requires its originating assistant tool call");
    let entry: InterviewEntry | undefined;
    const registry = new CakeOperationRegistry(
      operations({
        host: {
          appendEntry(type, data) {
            const decoded = Schema.decodeUnknownOption(InterviewEntry)(data);
            if (type !== "cake.interview/v1" || Option.isNone(decoded))
              throw new Error("Unsupported side-chat interview metadata");
            entry = decoded.value;
          },
        },
        async publishSnapshot() {
          if (!entry) throw new Error("The side-chat interview metadata is unavailable");
          // Persist before the user request. SDK commit publication refreshes the sidecar projection.
          await api.details(copyJson({ command: "interview.open", interview: entry }), context);
        },
      }).filter((operation) => operation.command === "interview.open"),
    );
    const result = await registry.invoke(input, {
      signal: context.abortSignal ?? new AbortController().signal,
      toolCallId: api.callId,
      runtime: {
        sessionId,
        assistantEntryId: String(source.value.assistant),
      },
    });
    if (!entry) throw new Error("The side-chat interview metadata is unavailable");
    return {
      output: result.content,
      details: copyJson({ command: "interview.open", interview: entry, operation: result.details }),
    };
  };
}
