import { Effect, Schema } from "effect";
import { parseSessionLink, sessionLink } from "../../contracts/conversations/message-reference";
import {
  ProjectTodoCreate,
  ProjectTodoUpdate,
  type ProjectTodoAssociation,
} from "../../contracts/projects/project-todos";
import { ProjectError } from "../../contracts/projects/project-error";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import { lookup } from "../project-sessions/projectSessionMetadata";
import * as sessionReferences from "../project-sessions/sessionReferences";
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

/** Canonicalize the same roster references accepted by session controls before storage. */
const validate = Effect.fn("ProjectTodos.validateAssociations")(function* (
  projectPath: string,
  links: readonly ProjectTodoAssociation[],
) {
  const result: ProjectTodoAssociation[] = [];
  for (const link of links) {
    const target = link.kind === "source" ? parseSessionLink(link.ref) : undefined;
    const reference = link.kind === "session" ? link.sessionId : target?.sessionId;
    if (!reference) {
      result.push(link);
      continue;
    }
    const sessionId = yield* sessionReferences.resolve(reference).pipe(asError);
    if (sessionId !== projectChatSessionId(projectPath)) {
      const session = yield* lookup({ sessionId }).pipe(asError);
      if (session.projectPath !== projectPath)
        return yield* new ProjectError({
          operation: "projectTodoAssociations",
          message: "Associated work must belong to this Project Chat's project",
        });
    }
    if (link.kind === "session") result.push({ ...link, sessionId });
    else {
      const ref = sessionLink(sessionId, target?.messageId, target?.attachmentId);
      // Exact report/message references must point to accessible original content.
      if (target?.messageId)
        yield* Effect.scoped(messageReferences.read({ ref, maxChars: 1 })).pipe(asError);
      result.push({ ...link, ref });
    }
  }
  return result;
});

export const create = Effect.fn("ProjectTodos.createWithAssociations")(function* (
  projectPath: string,
  request: ProjectTodoCreate,
) {
  const input = yield* Schema.decodeUnknownEffect(ProjectTodoCreate)(request).pipe(asError);
  return yield* todos.create(projectPath, {
    ...input,
    associations: yield* validate(projectPath, input.associations ?? []),
  });
});
export const update = Effect.fn("ProjectTodos.updateWithAssociations")(function* (
  projectPath: string,
  request: ProjectTodoUpdate,
) {
  const input = yield* Schema.decodeUnknownEffect(ProjectTodoUpdate)(request).pipe(asError);
  if (!input.associations) return yield* todos.update(projectPath, input);
  return yield* todos.update(projectPath, {
    ...input,
    associations: yield* validate(projectPath, input.associations),
  });
});
