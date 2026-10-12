import type { CakeOperationRuntime } from "../../contracts/agent/cake-operation-context";
import type { WidgetConversationOrigin } from "../../contracts/widgets/widget-conversation";

/** Capture before asynchronous generation so later messages cannot move the branch point. */
export function widgetConversationFromOperation(
  runtime: CakeOperationRuntime,
): WidgetConversationOrigin {
  const { sessionId, sessionFile, entryId } = runtime;
  if (!sessionId || !sessionFile || !entryId)
    throw new Error("Widget generation requires a persisted parent conversation");
  return { sessionId, sessionFile, entryId };
}
