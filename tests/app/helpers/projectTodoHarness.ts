import { Effect, Layer } from "effect";
import {
  emptyProjectTodos,
  CAKE_CHAT_TODO_SCOPE,
  type ProjectTodos,
  type ProjectTodoCreate,
} from "../../../src/contracts/projects/project-todos";
import { ApplicationWriteError } from "../../../src/contracts/storage/application-storage-errors";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { upsertProject } from "../../../src/domain/application/application";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import * as todos from "../../../src/domain/projects/projectTodos";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";

export const fullProjectTodos = (): ProjectTodos => ({
  ...emptyProjectTodos(),
  items: Array.from({ length: 1000 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    title: `Task ${index}`,
    description: "Existing work",
    status: "",
    state: "open" as const,
    revision: 0,
    associations: [],
  })),
});

/** Seed a pre-constraint saved association layout; ordinary mutation tests must use create. */
export const seedHistoricalTodo = Effect.fn("Test.seedHistoricalTodo")(function* (
  scope: string,
  input: ProjectTodoCreate,
) {
  const item = yield* todos.create(scope, { ...input, associations: [] });
  const historical = { ...item, associations: input.associations ?? [] };
  yield* (yield* ApplicationState).transact((state) =>
    Effect.succeed({
      ...state,
      ...(scope === CAKE_CHAT_TODO_SCOPE
        ? {
            cakeChatTodos: {
              ...(state.cakeChatTodos ?? emptyProjectTodos()),
              items: (state.cakeChatTodos?.items ?? []).map((value) =>
                value.id === item.id ? historical : value,
              ),
            },
          }
        : {
            projects: state.projects.map((project) =>
              project.path === scope
                ? {
                    ...project,
                    todos: {
                      ...(project.todos ?? emptyProjectTodos()),
                      items: (project.todos?.items ?? []).map((value) =>
                        value.id === item.id ? historical : value,
                      ),
                    },
                  }
                : project,
            ),
          }),
    }),
  );
  return historical;
});

/** Real serialized application authority; only persistence is replaced. */
export const projectTodoLayer = (
  settings: {
    initialTodos?: ProjectTodos;
    initialCakeChatTodos?: ProjectTodos;
    failSave?: boolean;
  } = {},
) =>
  Layer.effectContext(
    Effect.gen(function* () {
      let initialized = false;
      const context = yield* Layer.build(
        ApplicationState.layer.pipe(
          Layer.provide(
            Layer.succeed(
              ApplicationStorage,
              ApplicationStorage.of({
                load: () => Effect.succeed({ state: defaultApplicationState(), source: "current" }),
                save: () =>
                  initialized && settings.failSave
                    ? Effect.fail(
                        new ApplicationWriteError({
                          stage: "write",
                          message: "To-do disk unavailable",
                        }),
                      )
                    : Effect.void,
              }),
            ),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        yield* upsertProject("/project", "Project");
        yield* (yield* ApplicationState).transact((state) =>
          Effect.succeed({
            ...state,
            ...(settings.initialCakeChatTodos
              ? { cakeChatTodos: settings.initialCakeChatTodos }
              : {}),
            projects: state.projects.map((project) => ({
              ...project,
              ...(settings.initialTodos ? { todos: settings.initialTodos } : {}),
            })),
          }),
        );
      }).pipe(Effect.provide(context));
      initialized = true;
      return context;
    }),
  );
