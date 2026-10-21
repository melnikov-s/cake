import { mutateUser } from "../../domain/projects/projectTodos";
import { ProjectTodoRpc } from "../protocol/ProjectTodoRpc";

export const projectTodoHandlers = ProjectTodoRpc.of({
  "projectTodos.mutateUser": ({ projectPath, mutation }) => mutateUser(projectPath, mutation),
});
