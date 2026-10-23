import { SubagentStorage } from "../../services/storage/SubagentStorage";
import { SubagentHandleId } from "../../contracts/subagents/subagent-data";
import { parseSubagentLink, subagentLink } from "../../contracts/subagents/subagent-reference";
import { Effect, Schema } from "effect";
import { parseSessionLink, sessionLink } from "../../contracts/conversations/message-reference";
import {
  ProjectTodoCreate,
  ProjectTodoUpdate,
  ProjectTodoListInput,
  ProjectTodoUpdates,
  type ProjectTodoAssociation,
} from "../../contracts/projects/project-todos";
import { ProjectError } from "../../contracts/projects/project-error";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import { lookup } from "../project-sessions/projectSessionMetadata";
import * as sessionReferences from "../project-sessions/sessionReferences";
import * as messageReferences from "../conversations/messageReferences";
import * as todos from "./projectTodos";
import { agentListPage } from "../../contracts/agent/agent-list-data";
import { join, completeLinked } from "./projectTodoResolution";

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
    const worker =
      link.kind === "subagent"
        ? link
        : link.kind === "source"
          ? parseSubagentLink(link.ref)
          : undefined;
    if (worker) {
      const parentSessionId = yield* sessionReferences
        .resolve(worker.parentSessionId)
        .pipe(asError);
      const storage = yield* SubagentStorage;
      const handleId = SubagentHandleId.make(worker.handleId);
      const record =
        (yield* storage.get(handleId).pipe(asError)) ??
        (yield* storage.history.get(handleId).pipe(asError));
      if (
        !record ||
        record.parentSessionId !== parentSessionId ||
        (record.projectPath ?? record.parentWorkingDirectory) !== projectPath
      )
        return yield* new ProjectError({
          operation: "projectTodoAssociations",
          message:
            "Unknown subagent handle, wrong parent, or subagent outside this Project Chat’s project",
        });
      if (link.kind === "subagent") result.push({ ...link, parentSessionId });
      else if (link.kind === "source")
        result.push({ ...link, ref: subagentLink(parentSessionId, worker.handleId) });
      continue;
    }
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
    else if (link.kind === "source") {
      const ref = sessionLink(sessionId, target?.messageId, target?.attachmentId);
      // Exact report/message references must point to accessible original content.
      if (target?.messageId)
        yield* Effect.scoped(messageReferences.read({ ref, maxChars: 1 })).pipe(asError);
      result.push({ ...link, ref });
    }
  }
  return result;
});

export const list = Effect.fn("ProjectTodos.listForAgent")(function* (
  projectPath: string,
  request: ProjectTodoListInput,
) {
  const input = yield* Schema.decodeUnknownEffect(ProjectTodoListInput)(request).pipe(asError);
  const query = input.query?.toLowerCase();
  const value = yield* todos.list(projectPath);
  const page = agentListPage(
    value.items.filter(
      (item) =>
        (!input.state || item.state === input.state) &&
        (!query || item.title.toLowerCase().includes(query)),
    ),
    input,
  );
  const summary = (item: (typeof value.items)[number]) => ({
    id: item.id,
    title: item.title,
    state: item.state,
    revision: item.revision,
  });
  if (input.view !== "reconciliation") return { ...page, items: page.items.map(summary) };
  const joined = yield* join(projectPath, page.items);
  return {
    ...page,
    items: joined.map(({ item, sessions }) => ({
      ...summary(item),
      sessions,
    })),
  };
});

export const read = Effect.fn("ProjectTodos.readForAgent")(function* (
  projectPath: string,
  id: string,
) {
  const item = yield* todos.read(projectPath, id);
  const [joined] = yield* join(projectPath, [item]);
  return { ...item, sessions: joined?.sessions ?? [] };
});

export const updateMany = Effect.fn("ProjectTodos.updateManyWithAssociations")(function* (
  projectPath: string,
  request: readonly ProjectTodoUpdate[],
) {
  const inputs = yield* Schema.decodeUnknownEffect(ProjectTodoUpdates)(request).pipe(asError);
  const canonical = yield* Effect.forEach(inputs, (input) =>
    Effect.gen(function* () {
      return input.associations
        ? { ...input, associations: yield* validate(projectPath, input.associations) }
        : input;
    }),
  );
  const changesWork = canonical.filter((input) => input.state === undefined);
  const current = changesWork.length ? (yield* todos.list(projectPath)).items : [];
  const candidates = changesWork.flatMap((input) => {
    const item = current.find((item) => item.id === input.id);
    return item?.state === "open" ? [{ ...item, ...input }] : [];
  });
  const joined = yield* join(projectPath, candidates);
  const resolved = new Set(
    joined
      .filter(
        ({ sessions }) => sessions.length && sessions.every((session) => session.resolved === true),
      )
      .map(({ item }) => item.id),
  );
  yield* todos.updateMany(projectPath, canonical, false, resolved);
  yield* completeLinked(projectPath);
  return yield* Effect.forEach(canonical, (input) => todos.read(projectPath, input.id));
});

export const create = Effect.fn("ProjectTodos.createWithAssociations")(function* (
  projectPath: string,
  request: ProjectTodoCreate,
) {
  const input = yield* Schema.decodeUnknownEffect(ProjectTodoCreate)(request).pipe(asError);
  const associations = yield* validate(projectPath, input.associations ?? []);
  const [joined] = yield* join(projectPath, [
    {
      ...input,
      associations,
      id: "00000000-0000-4000-8000-000000000000",
      state: "open",
      revision: 0,
      status: input.status ?? "",
    },
  ]);
  const resolved = Boolean(
    joined?.sessions.length && joined.sessions.every((session) => session.resolved === true),
  );
  const item = yield* todos.create(projectPath, { ...input, associations }, resolved);
  yield* completeLinked(projectPath);
  return yield* todos.read(projectPath, item.id);
});
export const update = Effect.fn("ProjectTodos.updateWithAssociations")(function* (
  projectPath: string,
  request: ProjectTodoUpdate,
) {
  const input = yield* Schema.decodeUnknownEffect(ProjectTodoUpdate)(request).pipe(asError);
  const [item] = yield* updateMany(projectPath, [input]);
  if (!item)
    return yield* new ProjectError({
      operation: "projectTodoAssociations",
      message: "Unknown to-do",
    });
  return item;
});
