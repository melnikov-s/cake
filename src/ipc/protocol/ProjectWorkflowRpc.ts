import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  ProjectWorkflow,
  WorkflowStatus,
  WorkflowStatusMutation,
  ProjectWorkflowSessionDetails,
  ProjectWorkflowSessionDestination,
} from "../../domain/application/application-data";
import { ProjectError } from "../../domain/projects/project-error";

export const ProjectWorkflowRpc = RpcGroup.make(
  Rpc.make("projectWorkflow.mutateGlobal", {
    payload: Schema.Struct({ mutation: WorkflowStatusMutation }),
    success: Schema.Array(WorkflowStatus),
    error: ProjectError,
  }),
  Rpc.make("projectWorkflow.mutate", {
    payload: Schema.Struct({
      projectPath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
      mutation: WorkflowStatusMutation,
    }),
    success: ProjectWorkflow,
    error: ProjectError,
  }),
  Rpc.make("projectWorkflow.moveSession", {
    payload: Schema.Struct({
      projectPath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
      sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      workingDirectory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
      destination: ProjectWorkflowSessionDestination,
    }),
    success: ProjectWorkflow,
    error: ProjectError,
  }),
  Rpc.make("projectWorkflow.describeSession", {
    payload: Schema.Struct({
      projectPath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
      sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      workingDirectory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
      title: Schema.String.check(Schema.isMaxLength(500)),
      firstUserMessage: Schema.optionalKey(
        Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_000)),
      ),
    }),
    success: ProjectWorkflowSessionDetails,
    error: ProjectError,
  }),
);
