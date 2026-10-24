import { createHash, randomUUID } from "node:crypto";
import { clearCompletedProjectTodoSelection } from "../../utils/project-todo-selection";
import type { ProjectTodoContextReceipt } from "../../contracts/projects/project-todo-context";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import { Effect, Schema } from "effect";
import {
  addSessionDigestReminder,
  splitSessionDigestReminder,
} from "../../contracts/cake-chats/session-digest-reminder";
import { ApplicationState } from "../../services/storage/ApplicationState";
import type { ApplicationState as ApplicationStateValue } from "../../contracts/application/application-data";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import { ProjectError } from "../../contracts/projects/project-error";
import {
  CAKE_CHAT_TODO_SCOPE,
  emptyProjectTodos,
  isCakeChatTodoScope,
  todoChatForScope,
  ProjectTodoUpdates,
  type ProjectTodo,
  projectTodoReminder,
  ProjectTodoCreate,
  projectTodoCompletionSummary,
  type ProjectTodoCompletion,
  type ProjectTodoUpdate,
  ProjectTodoUserMutation,
  type ProjectTodos,
  type ProjectTodoUserChange,
} from "../../contracts/projects/project-todos";

const error = (message: string) => new ProjectError({ operation: "projectTodos", message });
const mapError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => error(cause instanceof Error ? cause.message : String(cause))),
  );

/** Commit one revision. Entering done records who completed it at this revision; staying done
 * keeps the original record, so any later content edit makes the completion no longer latest. */
function commit(
  item: ProjectTodo,
  changes: Partial<
    Pick<ProjectTodo, "title" | "description" | "status" | "state" | "associations">
  >,
  by: ProjectTodoCompletion["by"],
): ProjectTodo {
  const { completion, ...rest } = item;
  const next = { ...rest, ...changes, revision: item.revision + 1 };
  if (next.state !== "done") return next;
  if (item.state === "done") return completion ? { ...next, completion } : next;
  return { ...next, completion: { revision: next.revision, by } };
}

/** The only change since the caller's read was the completion it is also asking for. */
const onlyCompletedSince = (item: ProjectTodo, expectedRevision: number) =>
  item.state === "done" &&
  item.completion?.revision === item.revision &&
  expectedRevision === item.revision - 1;

function conflict(item: ProjectTodo, input: ProjectTodoUpdate) {
  const current = `current revision ${item.revision}`;
  if (input.state === "done" && item.state === "done")
    return error(
      `Atomic update rejected: to-do ${item.id} is already done (${projectTodoCompletionSummary(item)}) and was also edited after your revision ${input.expectedRevision} (${current}); no state change is needed. Reread it before re-applying title/description/status/association edits; no items committed`,
    );
  const completed =
    item.state === "done" && item.completion && input.expectedRevision < item.completion.revision
      ? `; ${projectTodoCompletionSummary(item)} at revision ${item.completion.revision}`
      : "";
  return error(
    `Atomic update rejected: to-do ${item.id} changed (${current}${completed}); no items committed`,
  );
}

/** The stored list for a scope: a registered Project's list or global Cake Chat's own list. */
function stored(state: ApplicationStateValue, scope: string) {
  if (isCakeChatTodoScope(scope)) return state.cakeChatTodos ?? emptyProjectTodos();
  return state.projects.find((item) => item.path === scope)?.todos;
}

/** All edits serialize against the existing ApplicationStorage authority; no parallel queue/file.
 * `scope` is a registered Project path or CAKE_CHAT_TODO_SCOPE for global Cake Chat. */
const change = Effect.fn("ProjectTodos.change")(function* (
  scope: string,
  transition: (todos: ProjectTodos) => Effect.Effect<ProjectTodos, ProjectError>,
) {
  const application = yield* ApplicationState;
  const next = yield* application
    .transact((current) =>
      Effect.gen(function* () {
        const global = isCakeChatTodoScope(scope);
        if (!global && !current.projects.some((item) => item.path === scope))
          return yield* error("Unknown registered project");
        const todos = clearCompletedProjectTodoSelection(
          yield* transition(stored(current, scope) ?? emptyProjectTodos()),
          randomUUID,
        );
        return global
          ? { ...current, cakeChatTodos: todos }
          : {
              ...current,
              projects: current.projects.map((item) =>
                item.path === scope ? { ...item, todos } : item,
              ),
            };
      }),
    )
    .pipe(mapError);
  return stored(next, scope) ?? emptyProjectTodos();
});

export const list = Effect.fn("ProjectTodos.list")(function* (scope: string) {
  const application = yield* ApplicationState;
  const state = application.snapshot();
  if (!isCakeChatTodoScope(scope) && !state.projects.some((item) => item.path === scope))
    return yield* error("Unknown registered project");
  return stored(state, scope) ?? emptyProjectTodos();
});

export const read = Effect.fn("ProjectTodos.read")(function* (scope: string, id: string) {
  const item = (yield* list(scope)).items.find((item) => item.id === id);
  if (!item) return yield* error("Unknown to-do in this list");
  return item;
});

export const create = Effect.fn("ProjectTodos.create")(function* (
  scope: string,
  request: ProjectTodoCreate,
  resolved = false,
) {
  const input = yield* Schema.decodeUnknownEffect(ProjectTodoCreate)(request).pipe(mapError);
  const item = {
    ...input,
    status: input.status ?? "",
    associations: input.associations ?? [],
    id: randomUUID(),
    state: resolved ? ("done" as const) : ("open" as const),
    revision: 0,
    ...(resolved ? { completion: { revision: 0, by: "sessions" as const } } : null),
  };
  yield* change(scope, (value) =>
    value.items.length >= 1000
      ? Effect.fail(error("To-do list is full"))
      : Effect.succeed({ ...value, items: [...value.items, item] }),
  );
  return item;
});

export const update = Effect.fn("ProjectTodos.update")(function* (
  scope: string,
  request: ProjectTodoUpdate,
  user = false,
) {
  const [item] = yield* updateMany(scope, [request], user);
  if (!item) return yield* error("Unknown to-do in this list");
  return item;
});

/** Validate and commit the whole bounded batch in one storage transaction, or write nothing. */
export const updateMany = Effect.fn("ProjectTodos.updateMany")(function* (
  scope: string,
  requests: readonly ProjectTodoUpdate[],
  user = false,
  resolved: ReadonlySet<string> = new Set(),
) {
  const inputs = yield* Schema.decodeUnknownEffect(ProjectTodoUpdates)(requests).pipe(mapError);
  const next = yield* change(scope, (value) =>
    Effect.gen(function* () {
      let result = value;
      for (const input of inputs) {
        const item = result.items.find((item) => item.id === input.id);
        if (!item) return yield* error("Unknown to-do in this list");
        // Only a redundant done is special: a redundant open still commits a revision, so an
        // explicit "keep open" beats a racing automatic completion.
        const alreadyDone = input.state === "done" && item.state === "done";
        const edits =
          input.title !== undefined ||
          input.description !== undefined ||
          input.status !== undefined ||
          input.associations !== undefined;
        // Already done and nothing else changes: idempotent, no new revision.
        if (alreadyDone && !edits) continue;
        // A completion changes only state. A stale "done" edit that raced exactly that completion
        // agrees with it, so its other fields overwrite nothing newer; anything else conflicts.
        if (
          item.revision !== input.expectedRevision &&
          !(alreadyDone && onlyCompletedSince(item, input.expectedRevision))
        )
          return yield* conflict(item, input);
        const automatic = input.state === undefined && resolved.has(item.id);
        const updated = commit(
          item,
          {
            title: input.title ?? item.title,
            description: input.description ?? item.description,
            status: input.status ?? item.status,
            state: input.state ?? (automatic && item.state === "open" ? "done" : item.state),
            associations: input.associations ?? item.associations,
          },
          automatic ? "sessions" : user ? "user" : "agent",
        );
        result = {
          ...result,
          items: result.items.map((candidate) => (candidate.id === item.id ? updated : candidate)),
        };
        if (user && updated.state !== item.state)
          result = enqueue(result, {
            _tag: "ItemState",
            sequence: result.sequence + 1,
            id: item.id,
            title: updated.title,
            state: updated.state,
          });
      }
      return result;
    }),
  );
  return inputs.flatMap((input) => next.items.filter((item) => item.id === input.id));
});

/** Persist automatic completion through the same authority/projection as explicit user edits.
 * No write/publication for a repeated reconciliation with no candidates.
 */
export const completeResolved = Effect.fn("ProjectTodos.completeResolved")(function* (
  scope: string,
  candidates: readonly Pick<ProjectTodo, "id" | "revision">[],
) {
  if (!candidates.length) return;
  yield* change(scope, (value) => {
    let result = value;
    for (const candidate of candidates) {
      const item = result.items.find((item) => item.id === candidate.id);
      if (!item || item.state !== "open" || item.revision !== candidate.revision) continue;
      const updated = commit(item, { state: "done" }, "sessions");
      result = enqueue(
        { ...result, items: result.items.map((other) => (other.id === item.id ? updated : other)) },
        {
          _tag: "ItemState",
          id: item.id,
          title: item.title,
          state: "done",
          sequence: result.sequence + 1,
        },
      );
    }
    return Effect.succeed(result);
  });
});

const changeKey = (entry: ProjectTodoUserChange) =>
  entry._tag === "Selection"
    ? "selection"
    : entry._tag === "ItemState"
      ? `item:${entry.id}`
      : `session:${entry.sessionId}`;
function enqueue(value: ProjectTodos, entry: ProjectTodoUserChange): ProjectTodos {
  return {
    ...value,
    sequence: entry.sequence,
    deliveryToken: randomUUID(),
    pending: [...value.pending.filter((old) => changeKey(old) !== changeKey(entry)), entry],
  };
}

export const mutateUser = Effect.fn("ProjectTodos.mutateUser")(function* (
  scope: string,
  request: ProjectTodoUserMutation,
) {
  const input = yield* Schema.decodeUnknownEffect(ProjectTodoUserMutation)(request).pipe(mapError);
  if (input._tag === "SetState") {
    yield* update(
      scope,
      { id: input.id, expectedRevision: input.expectedRevision, state: input.state },
      true,
    );
    return yield* list(scope);
  }
  return yield* change(scope, (value) => {
    if (
      input.selectedId !== null &&
      !value.items.some((item) => item.id === input.selectedId && item.state === "open")
    )
      return Effect.fail(error("Select an open to-do in this list"));
    return Effect.succeed(
      value.selectedId === input.selectedId
        ? value
        : enqueue(
            { ...value, selectedId: input.selectedId },
            { _tag: "Selection", selectedId: input.selectedId, sequence: value.sequence + 1 },
          ),
    );
  });
});

/** Keep automatic rows brief; the complete creation prompt remains in Pi. */
function sessionDescription(brief: string, title: string): string {
  const paragraph = (brief.trim().split(/\r?\n\s*\r?\n/, 1)[0] ?? "").replace(/\s+/g, " ");
  const text = paragraph.split(/(?<=[.!?])\s+/, 2).join(" ") || `Continue work in ${title}.`;
  return text.length > 320 ? `${text.slice(0, 319).trimEnd()}…` : text;
}

/** Creation bookkeeping, serialized by the same authority as manual edits.
 * Stable identity keeps retries idempotent even after an agent edits the links. */
export const ensureSession = Effect.fn("ProjectTodos.ensureSession")(function* (
  scope: string,
  sessionId: string,
  title: string,
  brief: string,
) {
  const hash = createHash("sha256").update(`cake:session-todo:${sessionId}`).digest("hex");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const name = title.trim().slice(0, 512).trim() || "New Project Session";
  const description = sessionDescription(brief, name);
  yield* change(scope, (value) => {
    if (
      value.items.some(
        (item) =>
          item.id === id ||
          item.associations.some((link) => link.kind === "session" && link.sessionId === sessionId),
      )
    )
      return Effect.succeed(value);
    if (value.items.length >= 1000) return Effect.fail(error("To-do list is full"));
    return Effect.succeed({
      ...value,
      items: [
        ...value.items,
        {
          id,
          title: name,
          description,
          status: "",
          state: "open" as const,
          revision: 0,
          associations: [{ kind: "session" as const, sessionId, title: name }],
        },
      ],
    });
  });
});

/** Call only after native lifecycle authority confirms an actual transition (UI or tool). */
export const recordSessionChange = Effect.fn("ProjectTodos.recordSessionChange")(function* (
  scope: string,
  sessionId: string,
  title: string,
  resolved: boolean,
) {
  yield* change(scope, (value) =>
    Effect.succeed(
      enqueue(value, {
        _tag: "SessionState",
        sequence: value.sequence + 1,
        sessionId,
        title,
        resolved,
      }),
    ),
  );
});

/** Read-only preparation. Only consumed durable originals can acknowledge this receipt. */
export const prepareUserContext = Effect.fn("ProjectTodos.prepareUserContext")(function* (
  scope: string,
  text: string,
) {
  const value = yield* list(scope);
  const reminder = projectTodoReminder(value, todoChatForScope(scope));
  const digest = splitSessionDigestReminder(text);
  return {
    text: addSessionDigestReminder(
      reminder ? `${reminder}\n\n${digest.text}` : digest.text,
      digest.reminder,
    ),
    sequence: value.sequence,
    selectedId: value.selectedId,
  };
});

/** The to-do list owned by a permanent chat, if that chat keeps one. */
const scopeForChat = Effect.fn("ProjectTodos.scopeForChat")(function* (sessionId: string) {
  if (sessionId === CAKE_CHAT_SESSION_ID) return CAKE_CHAT_TODO_SCOPE;
  if (!sessionId.startsWith("project-chat:")) return undefined;
  const application = yield* ApplicationState;
  const project = application
    .snapshot()
    .projects.find((item) => projectChatSessionId(item.path) === sessionId);
  if (!project) return yield* error("Unknown Project Chat");
  return project.path;
});

export const prepareForChat = Effect.fn("ProjectTodos.prepareForChat")(function* (
  sessionId: string,
  text: string,
) {
  const scope = yield* scopeForChat(sessionId);
  if (scope === undefined) return { text };
  const prepared = yield* prepareUserContext(scope, text);
  return {
    text: prepared.text,
    selection: prepared.selectedId
      ? { scope, id: prepared.selectedId, sequence: prepared.sequence }
      : undefined,
  };
});

/** Consume only the selection captured by an accepted user input, not its delivery receipt.
 * Other reminders still wait for durable consumption. A later selection (even A → B → A)
 * wins over an in-flight admission; unrelated edits do not prevent deselection.
 */
export const consumeSelection = Effect.fn("ProjectTodos.consumeSelection")(function* (prepared: {
  readonly selection?: { scope: string; id: string; sequence: number };
}) {
  const selection = prepared.selection;
  if (!selection) return;
  yield* change(selection.scope, (current) => {
    if (
      current.selectedId !== selection.id ||
      current.pending.some(
        (entry) => entry._tag === "Selection" && entry.sequence > selection.sequence,
      )
    )
      return Effect.succeed(current);
    // Automatic consumption is not another user selection change. Do not invalidate the
    // admitted input's receipt or remove its other pending reminders.
    const pending = current.pending.filter((entry) => entry._tag !== "Selection");
    return Effect.succeed({
      ...current,
      selectedId: null,
      pending,
      deliveryToken: pending.length ? current.deliveryToken : null,
    });
  });
});

export const acknowledge = Effect.fn("ProjectTodos.acknowledge")(function* (
  scope: string,
  receipt: ProjectTodoContextReceipt,
) {
  const matches = (value: ProjectTodos) =>
    value.deliveryToken === receipt.token && value.sequence === receipt.sequence;
  const value = yield* list(scope);
  if (!value.pending.length || !matches(value)) return;
  yield* change(scope, (current) =>
    Effect.succeed(matches(current) ? { ...current, pending: [], deliveryToken: null } : current),
  );
});
