import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CakeOperationRuntime } from "../../../contracts/agent/cake-operation-context";

/** Keep Pi history and model objects behind the adapter's scalar tool context. */
export function projectCakeOperationRuntime(
  runtime: Pick<ExtensionContext, "sessionManager" | "model">,
  toolCallId: string,
): CakeOperationRuntime {
  const manager = runtime.sessionManager;
  return {
    sessionId: manager.getSessionId(),
    sessionFile: manager.getSessionFile(),
    entryId: manager.getLeafId() ?? undefined,
    assistantEntryId: manager
      .getBranch()
      .findLast(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.content.some(
            (block) => block.type === "toolCall" && block.id === toolCallId,
          ),
      )?.id,
    model: runtime.model ? { provider: runtime.model.provider, id: runtime.model.id } : undefined,
  };
}
