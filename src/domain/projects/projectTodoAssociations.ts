import { Effect } from "effect";
import { parseSessionLink } from "../../contracts/conversations/message-reference";
import type {
  ProjectTodoAssociation,
  ProjectTodoCreate,
  ProjectTodoUpdate,
} from "../../contracts/projects/project-todos";
import { ProjectError } from "../../contracts/projects/project-error";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import { lookup } from "../project-sessions/projectSessionMetadata";
import { SessionFamilyStorage, familyMemberIds } from "../../services/storage/SessionFamilyStorage";
import * as messageReferences from "../conversations/messageReferences";
import * as todos from "./projectTodos";

const asError = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  operation.pipe(
    Effect.mapError(
      (cause) =>
        new ProjectError({
          operation: "projectTodoAssociations",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    ),
  );
const validate = Effect.fn("ProjectTodos.validateAssociations")(function* (
  projectPath: string,
  links: readonly ProjectTodoAssociation[],
) {
  for (const link of links) {
    const sessionId =
      link.kind === "session" ? link.sessionId : parseSessionLink(link.ref)?.sessionId;
    if (!sessionId)
      return yield* new ProjectError({
        operation: "projectTodoAssociations",
        message: "Expected an accessible session or exact source/report message",
      });
    if (link.kind === "session" || sessionId !== projectChatSessionId(projectPath)) {
      const session = yield* lookup({ sessionId }).pipe(asError);
      if (session.projectPath !== projectPath)
        return yield* new ProjectError({
          operation: "projectTodoAssociations",
          message: "Associated work must belong to this Project Chat's project",
        });
    }
    // Investigator runtimes have no navigable public session. A source association
    // points instead to an actual original launch/report message in its parent.
    if (link.kind === "source")
      yield* Effect.scoped(messageReferences.read({ ref: link.ref, maxChars: 1 })).pipe(asError);
  }
});

export const create = Effect.fn("ProjectTodos.createWithAssociations")(function* (
  projectPath: string,
  input: ProjectTodoCreate,
) {
  yield* validate(projectPath, input.associations ?? []);
  const item = yield* todos.create(projectPath, input);
  yield* reconcileResolved(projectPath);
  return yield* todos.read(projectPath, item.id);
});
export const update = Effect.fn("ProjectTodos.updateWithAssociations")(function* (
  projectPath: string,
  input: ProjectTodoUpdate,
) {
  if (input.associations) yield* validate(projectPath, input.associations);
  const item = yield* todos.update(projectPath, input);
  if (input.associations) yield* reconcileResolved(projectPath);
  return yield* todos.read(projectPath, item.id);
});

/** Read native lifecycle, including inherited family resolution; no parallel lifecycle authority. */
export const reconcileResolved = Effect.fn("ProjectTodos.reconcileResolved")(function* (
  projectPath: string,
  transitionedSessionId?: string,
) {
  const value = yield* todos.list(projectPath);
  let affected: ReadonlySet<string> | undefined;
  if (transitionedSessionId) {
    const family = yield* (yield* SessionFamilyStorage)
      .familyForMember(transitionedSessionId)
      .pipe(asError);
    affected = new Set(family ? familyMemberIds(family) : [transitionedSessionId]);
  }
  const candidates = value.items.filter(
    (item) =>
      item.state === "open" &&
      item.associations.length > 0 &&
      item.associations.every((link) => link.kind === "session") &&
      (!affected ||
        item.associations.some((link) => link.kind === "session" && affected.has(link.sessionId))),
  );
  if (!candidates.length) return;
  const ids = [
    ...new Set(
      candidates.flatMap((item) =>
        item.associations.flatMap((link) => (link.kind === "session" ? [link.sessionId] : [])),
      ),
    ),
  ];
  const resolved: string[] = [];
  for (const sessionId of ids) {
    const current = yield* lookup({ sessionId }).pipe(Effect.result);
    // Deleted/unavailable work is not confirmed resolved. Keep its thread open,
    // rather than blocking an unrelated native lifecycle transition or inventing closure.
    if (
      current._tag === "Success" &&
      current.success.projectPath === projectPath &&
      current.success.resolved
    )
      resolved.push(sessionId);
  }
  if (resolved.length) yield* todos.completeLinked(projectPath, resolved);
});
