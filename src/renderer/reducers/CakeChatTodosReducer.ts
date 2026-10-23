import { applySnapshot, batch } from "r-state-tree";
import { emptyProjectTodos, type ProjectTodos } from "../../contracts/projects/project-todos";
import type { RendererApplicationProjection } from "../../contracts/application/application-data";
import type { CakeChatTodoList } from "../models/CakeChatTodoList";

export function applyCakeChatTodosProjection(
  model: CakeChatTodoList,
  projection: RendererApplicationProjection,
) {
  if (projection.revision <= model.revision) return;
  const todos: ProjectTodos = projection.state.cakeChatTodos ?? emptyProjectTodos();
  // Like a Project list: only an addition to a known, empty list opens the pane.
  const created = model.revision >= 0 && model.todos.items.length === 0 && todos.items.length > 0;
  batch(() => {
    applySnapshot(model, { revision: projection.revision, todos });
    if (created) model.todoCreationRevision += 1;
  });
}
