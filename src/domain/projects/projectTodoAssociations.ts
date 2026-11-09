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
  projectTodoCategory,
  isCakeChatTodoScope,
  type ProjectTodoAssociation,
} from "../../contracts/projects/project-todos";
import { ProjectError } from "../../contracts/projects/project-error";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import {
  isCakeChatSessionId,
  cakeChatSideChatConversationId,
} from "../../contracts/cake-chats/cake-chat-identity";
import * as discussionSessionReferences from "../discussion-sessions/discussionSessionReferences";
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

/** Canonicalize the same roster references accepted by session controls before storage.
 * A Project list accepts only its own Project's work; global Cake Chat's list accepts work in
 * any registered Project and messages in any permanent chat. */
const validate = Effect.fn("ProjectTodos.validateAssociations")(function* (
  scope: string,
  links: readonly ProjectTodoAssociation[],
) {
  const global = isCakeChatTodoScope(scope);
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
        (!global && (record.projectPath ?? record.parentWorkingDirectory) !== scope)
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
    const ownChat = global
      ? isCakeChatSessionId(sessionId)
      : sessionId === projectChatSessionId(scope);
    if (!ownChat) {
      const session =
        cakeChatSideChatConversationId(sessionId) !== undefined
          ? (yield* discussionSessionReferences.lookup(sessionId).pipe(asError)).reference
          : yield* lookup({ sessionId }).pipe(asError);
      if (!global && session.projectPath !== scope)
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
  scope: string,
  request: ProjectTodoListInput,
) {
  const input = yield* Schema.decodeUnknownEffect(ProjectTodoListInput)(request).pipe(asError);
  const query = input.query?.toLowerCase();
  // Repair only the requested list, before filtering/paging so newly completed items
  // appear in Done rather than leaking stale Open rows after an interrupted commit.
  yield* completeLinked(scope);
  const value = yield* todos.list(scope);
  const page = agentListPage(
    value.items.filter(
      (item) =>
        (!input.state || item.state === input.state) &&
        (!input.category || projectTodoCategory(item) === input.category) &&
        (!query || item.title.toLowerCase().includes(query)),
    ),
    input,
  );
  const summary = (item: (typeof value.items)[number]) => ({
    id: item.id,
    title: item.title,
    state: item.state,
    needsAttention: Boolean(item.needsAttention),
    ...(item.attentionReason ? { attentionReason: item.attentionReason } : null),
    ...(item.snoozedUntil ? { snoozedUntil: item.snoozedUntil } : null),
    ...(item.remainingWork ? { remainingWork: item.remainingWork } : null),
    revision: item.revision,
  });
  if (input.view !== "reconciliation") return { ...page, items: page.items.map(summary) };
  const joined = yield* join(scope, page.items);
  return {
    ...page,
    items: joined.map(({ item, sessions }) => ({
      ...summary(item),
      sessions,
    })),
  };
});

export const read = Effect.fn("ProjectTodos.readForAgent")(function* (scope: string, id: string) {
  yield* todos.read(scope, id);
  yield* completeLinked(scope, new Set([id]));
  const item = yield* todos.read(scope, id);
  const [joined] = yield* join(scope, [item]);
  return { ...item, sessions: joined?.sessions ?? [] };
});

export const updateMany = Effect.fn("ProjectTodos.updateManyWithAssociations")(function* (
  scope: string,
  request: readonly ProjectTodoUpdate[],
) {
  const inputs = yield* Schema.decodeUnknownEffect(ProjectTodoUpdates)(request).pipe(asError);
  const canonical = yield* Effect.forEach(inputs, (input) =>
    Effect.gen(function* () {
      return input.associations
        ? { ...input, associations: yield* validate(scope, input.associations) }
        : input;
    }),
  );
  const changesWork = canonical.filter((input) => input.state !== "open");
  const current = changesWork.length ? (yield* todos.list(scope)).items : [];
  const candidates = changesWork.flatMap((input) => {
    const item = current.find((item) => item.id === input.id);
    return item?.state === "open"
      ? [
          {
            ...item,
            associations:
              input.state === "done" && input.associations
                ? [...item.associations, ...input.associations]
                : (input.associations ?? item.associations),
          },
        ]
      : [];
  });
  const joined = yield* join(scope, candidates);
  const resolved = new Set(
    joined
      .filter(
        ({ sessions }) => sessions.length && sessions.every((session) => session.resolved === true),
      )
      .map(({ item }) => item.id),
  );
  for (const input of canonical) {
    if (input.state !== "done") continue;
    const candidate = joined.find(({ item }) => item.id === input.id);
    if (
      candidate &&
      ((input.remainingWork === undefined ? candidate.item.remainingWork : input.remainingWork) ||
        (candidate.sessions.length > 0 && !resolved.has(input.id)))
    )
      return yield* new ProjectError({
        operation: "projectTodoAssociations",
        message: "Cannot complete to-do: remaining work or unresolved required sessions",
      });
  }
  yield* todos.updateMany(scope, canonical, false, resolved);
  // Recheck only these items in case resolution raced their commit. Lifecycle/list-access
  // reconciliation owns other items; cheap edits must not wait on unrelated discovery.
  yield* completeLinked(scope, new Set(canonical.map((input) => input.id)));
  return yield* Effect.forEach(canonical, (input) => todos.read(scope, input.id));
});

export const create = Effect.fn("ProjectTodos.createWithAssociations")(function* (
  scope: string,
  request: ProjectTodoCreate,
) {
  const input = yield* Schema.decodeUnknownEffect(ProjectTodoCreate)(request).pipe(asError);
  const associations = yield* validate(scope, input.associations ?? []);
  const [joined] = yield* join(scope, [
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
  const item = yield* todos.create(scope, { ...input, associations }, resolved);
  yield* completeLinked(scope, new Set([item.id]));
  return yield* todos.read(scope, item.id);
});
export const update = Effect.fn("ProjectTodos.updateWithAssociations")(function* (
  scope: string,
  request: ProjectTodoUpdate,
) {
  const input = yield* Schema.decodeUnknownEffect(ProjectTodoUpdate)(request).pipe(asError);
  const [item] = yield* updateMany(scope, [input]);
  if (!item)
    return yield* new ProjectError({
      operation: "projectTodoAssociations",
      message: "Unknown to-do",
    });
  return item;
});
