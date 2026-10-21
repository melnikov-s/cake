import { createHash, randomUUID } from "node:crypto";
import type { ProjectTodoContextReceipt } from "../../contracts/projects/project-todo-context";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import { Effect, Schema } from "effect";
import {
  addSessionDigestReminder,
  splitSessionDigestReminder,
} from "../../contracts/cake-chats/session-digest-reminder";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { ProjectError } from "../../contracts/projects/project-error";
import {
  emptyProjectTodos,
  projectTodoReminder,
  ProjectTodoCreate,
  ProjectTodoUpdate,
  ProjectTodoUserMutation,
  type ProjectTodos,
  type ProjectTodoUserChange,
} from "../../contracts/projects/project-todos";

const error = (message: string) => new ProjectError({ operation: "projectTodos", message });
const mapError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => error(cause instanceof Error ? cause.message : String(cause))),
  );

/** All edits serialize against the existing ApplicationStorage authority; no parallel queue/file. */
const change = Effect.fn("ProjectTodos.change")(function* (
  projectPath: string,
  transition: (todos: ProjectTodos) => Effect.Effect<ProjectTodos, ProjectError>,
) {
  const application = yield* ApplicationState;
  const next = yield* application
    .transact((current) =>
      Effect.gen(function* () {
        const project = current.projects.find((item) => item.path === projectPath);
        if (!project) return yield* error("Unknown registered project");
        const todos = yield* transition(project.todos ?? emptyProjectTodos());
        return {
          ...current,
          projects: current.projects.map((item) =>
            item.path === projectPath ? { ...item, todos } : item,
          ),
        };
      }),
    )
    .pipe(mapError);
  return next.projects.find((item) => item.path === projectPath)?.todos ?? emptyProjectTodos();
});

export const list = Effect.fn("ProjectTodos.list")(function* (projectPath: string) {
  const application = yield* ApplicationState;
  const project = application.snapshot().projects.find((item) => item.path === projectPath);
  if (!project) return yield* error("Unknown registered project");
  return project.todos ?? emptyProjectTodos();
});

export const read = Effect.fn("ProjectTodos.read")(function* (projectPath: string, id: string) {
  const item = (yield* list(projectPath)).items.find((item) => item.id === id);
  if (!item) return yield* error("Unknown to-do in this project");
  return item;
});

export const create = Effect.fn("ProjectTodos.create")(function* (
  projectPath: string,
  request: ProjectTodoCreate,
) {
  const input = yield* Schema.decodeUnknownEffect(ProjectTodoCreate)(request).pipe(mapError);
  const item = {
    ...input,
    status: input.status ?? "",
    associations: input.associations ?? [],
    id: randomUUID(),
    state: "open" as const,
    revision: 0,
  };
  yield* change(projectPath, (value) =>
    value.items.length >= 1000
      ? Effect.fail(error("To-do list is full"))
      : Effect.succeed({ ...value, items: [...value.items, item] }),
  );
  return item;
});

export const update = Effect.fn("ProjectTodos.update")(function* (
  projectPath: string,
  request: ProjectTodoUpdate,
  user = false,
) {
  const input = yield* Schema.decodeUnknownEffect(ProjectTodoUpdate)(request).pipe(mapError);
  const next = yield* change(projectPath, (value) =>
    Effect.gen(function* () {
      const item = value.items.find((item) => item.id === input.id);
      if (!item) return yield* error("Unknown to-do in this project");
      if (item.revision !== input.expectedRevision)
        return yield* error("To-do changed; read it again before updating");
      const updated = {
        ...item,
        title: input.title ?? item.title,
        description: input.description ?? item.description,
        status: input.status ?? item.status,
        state: input.state ?? item.state,
        associations: input.associations ?? item.associations,
        revision: item.revision + 1,
      };
      let result: ProjectTodos = {
        ...value,
        items: value.items.map((candidate) => (candidate.id === item.id ? updated : candidate)),
      };
      if (user && updated.state !== item.state)
        result = enqueue(result, {
          _tag: "ItemState",
          sequence: value.sequence + 1,
          id: item.id,
          title: updated.title,
          state: updated.state,
        });
      return result;
    }),
  );
  const item = next.items.find((item) => item.id === input.id);
  if (!item) return yield* error("Unknown to-do in this project");
  return item;
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
  projectPath: string,
  request: ProjectTodoUserMutation,
) {
  const input = yield* Schema.decodeUnknownEffect(ProjectTodoUserMutation)(request).pipe(mapError);
  if (input._tag === "SetState") {
    yield* update(
      projectPath,
      { id: input.id, expectedRevision: input.expectedRevision, state: input.state },
      true,
    );
    return yield* list(projectPath);
  }
  return yield* change(projectPath, (value) => {
    if (input.selectedId !== null && !value.items.some((item) => item.id === input.selectedId))
      return Effect.fail(error("Unknown to-do in this project"));
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

/** Creation bookkeeping, serialized by the same authority as manual edits.
 * Stable identity keeps retries idempotent even after an agent edits the links. */
export const ensureSession = Effect.fn("ProjectTodos.ensureSession")(function* (
  projectPath: string,
  sessionId: string,
  title: string,
  brief: string,
) {
  const hash = createHash("sha256").update(`cake:session-todo:${sessionId}`).digest("hex");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const name = title.trim().slice(0, 512).trim() || "New Project Session";
  const description = brief.trim().slice(0, 2048).trim() || `Continue work in ${name}.`;
  yield* change(projectPath, (value) => {
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

/** Call only after a native lifecycle authority confirms an actual user transition. */
export const recordSessionChange = Effect.fn("ProjectTodos.recordSessionChange")(function* (
  projectPath: string,
  sessionId: string,
  title: string,
  resolved: boolean,
) {
  yield* change(projectPath, (value) =>
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
  projectPath: string,
  text: string,
) {
  const value = yield* list(projectPath);
  const reminder = projectTodoReminder(value);
  const digest = splitSessionDigestReminder(text);
  return {
    text: addSessionDigestReminder(
      reminder ? `${reminder}\n\n${digest.text}` : digest.text,
      digest.reminder,
    ),
    sequence: value.sequence,
  };
});

export const prepareForChat = Effect.fn("ProjectTodos.prepareForChat")(function* (
  sessionId: string,
  text: string,
) {
  if (!sessionId.startsWith("project-chat:")) return text;
  const application = yield* ApplicationState;
  const project = application
    .snapshot()
    .projects.find((item) => projectChatSessionId(item.path) === sessionId);
  if (!project) return yield* error("Unknown Project Chat");
  return (yield* prepareUserContext(project.path, text)).text;
});

export const acknowledge = Effect.fn("ProjectTodos.acknowledge")(function* (
  projectPath: string,
  receipt: ProjectTodoContextReceipt,
) {
  const matches = (value: ProjectTodos) =>
    value.deliveryToken === receipt.token && value.sequence === receipt.sequence;
  const value = yield* list(projectPath);
  if (!value.pending.length || !matches(value)) return;
  yield* change(projectPath, (current) =>
    Effect.succeed(matches(current) ? { ...current, pending: [], deliveryToken: null } : current),
  );
});
