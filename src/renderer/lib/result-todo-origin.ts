import type { UiPart } from "../../contracts/conversations/session-contract";
import { parseSessionLink } from "../../contracts/conversations/message-reference";
import { parseSubagentLink } from "../../contracts/subagents/subagent-reference";
import { messageReferencesInText } from "../../contracts/conversations/message-reference-forwarding";
import type { TodoResultOrigin } from "../stores/ProjectTodosStore";

/** Exact source identity, independent of the message or batch that presents it. */
export function referenceTodoOrigin(reference: string): TodoResultOrigin | undefined {
  const worker = parseSubagentLink(reference);
  if (worker) return { subagent: worker, references: [reference] };
  const target = parseSessionLink(reference);
  if (!target || target.attachmentId) return undefined;
  return {
    sessionIds: [target.sessionId],
    references: [reference],
    ...(target.messageId
      ? { message: { sessionId: target.sessionId, entryId: target.messageId } }
      : null),
  };
}

/** Incoming communication keeps its to-do association, including requests and older updates. */
export function resultTodoOrigin(
  part: UiPart,
  chatSessionId: string | undefined,
): TodoResultOrigin | undefined {
  if (part.kind !== "text") return undefined;
  const message =
    chatSessionId && part.entryId ? { sessionId: chatSessionId, entryId: part.entryId } : undefined;
  const references = messageReferencesInText(part.text);
  if (part.subagentReport && chatSessionId)
    return {
      subagent: { parentSessionId: chatSessionId, handleId: part.subagentReport.handleId },
      references,
      ...(message ? { message } : null),
    };
  const source = part.crossSession?.sender;
  if (!source) return part.agentSource ? referenceTodoOrigin(part.agentSource.href) : undefined;
  return {
    sessionIds: [source.sessionId],
    references,
    ...(message ? { message } : null),
  };
}
