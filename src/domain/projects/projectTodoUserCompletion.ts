import { Effect } from "effect";
import { cakeChatSideChatConversationId } from "../../contracts/cake-chats/cake-chat-identity";
import { ProjectError } from "../../contracts/projects/project-error";
import { isCakeChatTodoScope } from "../../contracts/projects/project-todos";
import * as discussionReferences from "../discussion-sessions/discussionSessionReferences";
import * as discussions from "../discussion-sessions/discussionSessions";
import * as lifecycle from "../project-sessions/projectSessionLifecycle";
import { findLocation } from "../project-sessions/projectSessionMetadata";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { join } from "./projectTodoResolution";
import * as todos from "./projectTodos";

const error = (message: string) => new ProjectError({ operation: "completeTodo", message });

/** Human Done only. Session-driven reconciliation calls completeResolved, never this path.
 * Resolve required work before persisting Done; partial success stays authoritative and retries
 * skip resolved links. No merge, checkout retirement, deletion or turn cancellation.
 */
export const complete = Effect.fn("ProjectTodos.completeFromUser")(
  function* (scope: string, id: string, expectedRevision: number) {
    const item = yield* todos.read(scope, id);
    // A repeated Done must not resolve work restored since the original completion.
    if (item.state === "done") return yield* todos.list(scope);
    if (item.revision !== expectedRevision)
      return yield* error(
        `To-do ${id} changed (current revision ${item.revision}); reread it before marking Done`,
      );
    const [joined] = yield* join(scope, [item]);
    const sessions = joined?.sessions ?? [];
    for (const session of sessions)
      if (session.resolved === null)
        return yield* error(`Cannot complete to-do: ${session.sessionId}: ${session.reason}`);

    const families = yield* SessionFamilyStorage;
    const targets = [];
    const selected = new Set<string>();
    // Preflight identities/scope before any resolution. Family children inherit their root's
    // lifecycle, so resolve the root once through its whole-family safety checks.
    for (const session of sessions) {
      if (session.resolved) continue;
      if (cakeChatSideChatConversationId(session.sessionId) !== undefined) {
        const { reference } = yield* discussionReferences.lookup(session.sessionId);
        targets.push({ kind: "discussion" as const, reference });
        continue;
      }
      const family = yield* families.familyForMember(session.sessionId);
      const sessionId = family?.parentSessionId ?? session.sessionId;
      if (selected.has(sessionId)) continue;
      const location = yield* findLocation({ sessionId });
      if (!isCakeChatTodoScope(scope) && location.projectPath !== scope)
        return yield* error(
          `Cannot complete to-do: session ${sessionId} belongs to another Project`,
        );
      targets.push({
        kind: "project" as const,
        sessionId,
        workingDirectory: location.workingDirectory,
      });
      selected.add(sessionId);
    }
    for (const target of targets) {
      if (target.kind === "discussion") yield* discussions.setResolved(target.reference, true);
      else yield* lifecycle.resolve(target, { preserveWork: true });
    }
    // Resolution may have automatically completed the item. Re-read associations before the
    // final commit; ordinary revision checks still reject concurrent content/ownership edits.
    const current = yield* todos.read(scope, id);
    const [verified] = yield* join(scope, [current]);
    if (verified?.sessions.some((session) => session.resolved !== true))
      return yield* error("Cannot complete to-do: required linked sessions are not all resolved");
    return yield* todos.mutateUser(scope, {
      _tag: "SetState",
      id,
      expectedRevision,
      state: "done",
    });
  },
  Effect.mapError((cause) => error(cause.message)),
);
