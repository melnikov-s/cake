import { Effect } from "effect";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { makePiCallbackExecutor } from "../../services/pi/PiCallbackAdapter";
import {
  CAKE_CHAT_TODO_SCOPE,
  emptyProjectTodos,
  projectTodoBaseline,
  type ProjectTodoControl,
} from "../../contracts/projects/project-todos";
import * as associations from "../projects/projectTodoAssociations";
import { scopeForChat } from "../projects/projectTodos";

export type DiscussionTodoServices =
  | ApplicationState
  | Effect.Services<ReturnType<typeof associations.create>>
  | Effect.Services<ReturnType<typeof associations.updateMany>>
  | Effect.Services<ReturnType<typeof associations.read>>;

/** A side chat gets only its real parent's list, without consuming parent input context. */
export const configuration = Effect.fn("DiscussionTodos.configuration")(function* (
  parentSessionId: string,
) {
  const scope = yield* scopeForChat(parentSessionId);
  if (scope === undefined) return undefined;
  const application = yield* ApplicationState;
  const run = makePiCallbackExecutor(yield* Effect.context<DiscussionTodoServices>());
  const projectTodos: ProjectTodoControl = {
    list: (input, signal) => run(associations.list(scope, input), { signal }),
    read: (id, signal) => run(associations.read(scope, id), { signal }),
    create: (input, signal) => run(associations.create(scope, input), { signal }),
    update: (input, signal) => run(associations.update(scope, input), { signal }),
    updateMany: (input, signal) => run(associations.updateMany(scope, input), { signal }),
  };
  const state = application.snapshot();
  const value =
    scope === CAKE_CHAT_TODO_SCOPE
      ? state.cakeChatTodos
      : state.projects.find((project) => project.path === scope)?.todos;
  return {
    projectTodos,
    systemPrompt: [
      "This side chat shares its parent's existing to-do list immediately. To-do changes are live in the parent without merging this conversation. Only todos.* and interview.open Cake controls are available here; return to the parent for session resolution or other actions. Parent selection and reminders are not consumed here.",
      projectTodoBaseline(
        value ?? emptyProjectTodos(),
        scope === CAKE_CHAT_TODO_SCOPE ? "Cake Chat" : "Project Chat",
      ),
    ].join("\n\n"),
  };
});
