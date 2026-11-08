import type { UiPart } from "../../contracts/conversations/session-contract";
import { parseSessionLink } from "../../contracts/conversations/message-reference";
import type { ProjectTodo } from "../../contracts/projects/project-todos";

/** Focus matches explicit message identity, never surrounding turns or source sessions. */
export function todoMessageMatches(part: UiPart, sessionId: string, todo: ProjectTodo): boolean {
  if (part.kind !== "text") return false;
  if (!part.deliveryState && !part.taskAttributionPending && part.taskTodoId === todo.id)
    return true;
  return Boolean(
    part.entryId &&
    todo.associations.some((link) => {
      if (link.kind !== "source") return false;
      const target = parseSessionLink(link.ref);
      return (
        target?.sessionId === sessionId && target.messageId === part.entryId && !target.attachmentId
      );
    }),
  );
}
