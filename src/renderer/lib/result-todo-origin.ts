import type { UiPart } from "../../contracts/conversations/session-contract";
import { parseSessionLink } from "../../contracts/conversations/message-reference";
import { sessionNotificationMarkdown } from "../../contracts/cake-chats/session-digest-reminder";
import type { TodoResultOrigin } from "../stores/ProjectTodosStore";
import { crossSessionPresentation } from "./cross-session-presentation";

const sessionLinks = /\]\((cake:\/\/session\/[^\s<>()[\]]+)\)/g;

/**
 * Where a result message in a chat transcript came from: a private worker report, a Project
 * Session's reply or notice, or the application's compact session-completion notice. Requests
 * and ordinary dialogue are not results.
 */
export function resultTodoOrigin(
  part: UiPart,
  chatSessionId: string | undefined,
): TodoResultOrigin | undefined {
  if (!chatSessionId) return undefined;
  if (part.kind === "context") {
    const notice = sessionNotificationMarkdown(part.text);
    if (!notice) return undefined;
    const sessionIds = [...notice.matchAll(sessionLinks)].flatMap((match) => {
      const target = parseSessionLink(match[1]!);
      return target ? [target.sessionId] : [];
    });
    return sessionIds.length ? { sessionIds } : undefined;
  }
  if (part.kind !== "text") return undefined;
  const message = part.entryId ? { sessionId: chatSessionId, entryId: part.entryId } : undefined;
  if (part.subagentReport)
    return {
      subagent: { parentSessionId: chatSessionId, handleId: part.subagentReport.handleId },
      ...(message ? { message } : null),
    };
  const sender = part.crossSession?.sender;
  if (
    !part.crossSession ||
    sender?.kind !== "project-session" ||
    crossSessionPresentation(part.text, part.crossSession).relation === "request"
  )
    return undefined;
  return { sessionIds: [sender.sessionId], ...(message ? { message } : null) };
}
