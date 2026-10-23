import { mutateUser } from "../../domain/projects/projectTodos";
import { ProjectTodoRpc } from "../protocol/ProjectTodoRpc";

export const projectTodoHandlers = ProjectTodoRpc.of({
  "projectTodos.mutateUser": ({ scope, mutation }) => mutateUser(scope, mutation),
});
