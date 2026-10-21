import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ProjectTodoUserMutation, ProjectTodos } from "../../contracts/projects/project-todos";
import { ProjectError } from "../../contracts/projects/project-error";

export const ProjectTodoRpc = RpcGroup.make(
  Rpc.make("projectTodos.mutateUser", {
    payload: Schema.Struct({
      projectPath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
      mutation: ProjectTodoUserMutation,
    }),
    success: ProjectTodos,
    error: ProjectError,
  }),
);
