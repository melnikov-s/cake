import type { ContextEvent, InlineExtension } from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextEvent["messages"][number];

export const EMPTY_TOOL_ERROR_PLACEHOLDER = "Tool failed without an error message.";

const omittedErrorFields = new Set(["_tag", "message", "stack", "cause"]);

/**
 * Pi sends a thrown error's `message` as the failed tool result. Tagged errors may have
 * none, so name the error and its fields instead of sending empty text.
 */
export function toolFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error).trim() || EMPTY_TOOL_ERROR_PLACEHOLDER;
  if (error.message.trim() !== "") return error.message;
  const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : error.name;
  const fields = Object.fromEntries(
    Object.entries(error).filter(([key]) => !omittedErrorFields.has(key)),
  );
  const name = tag.trim() || EMPTY_TOOL_ERROR_PLACEHOLDER;
  return Object.keys(fields).length > 0 ? `${name} ${JSON.stringify(fields)}` : name;
}

/**
 * Anthropic rejects a failed tool result with empty content, and Pi resends the same
 * history on every retry, so one empty failure would block the session forever. The
 * stored transcript stays untouched; only the outgoing request gets placeholder text.
 */
export function fillEmptyToolErrors(messages: AgentMessage[]): AgentMessage[] | undefined {
  let changed = false;
  const filled = messages.map((message) => {
    if (
      message.role !== "toolResult" ||
      !message.isError ||
      message.content.some((part) => part.type === "image" || part.text.trim() !== "")
    )
      return message;
    changed = true;
    return {
      ...message,
      content: [{ type: "text" as const, text: EMPTY_TOOL_ERROR_PLACEHOLDER }],
    };
  });
  return changed ? filled : undefined;
}

export const emptyToolErrorExtension: InlineExtension = (pi) => {
  pi.on("context", (event) => {
    const messages = fillEmptyToolErrors(event.messages);
    return messages ? { messages } : undefined;
  });
};
