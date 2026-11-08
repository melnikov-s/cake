import { activate } from "../../domain/projects/projectTodoAttention";
import { mutateUser } from "../../domain/projects/projectTodos";
import { complete } from "../../domain/projects/projectTodoUserCompletion";
import { ProjectTodoRpc } from "../protocol/ProjectTodoRpc";

export const projectTodoHandlers = ProjectTodoRpc.of({
  "projectTodos.activateAttention": ({ scope, id, expectedRevision }) =>
    activate(scope, id, expectedRevision),
  "projectTodos.mutateUser": ({ scope, mutation }) =>
    mutation._tag === "SetState" && mutation.state === "done"
      ? complete(scope, mutation.id, mutation.expectedRevision)
      : mutateUser(scope, mutation),
});
