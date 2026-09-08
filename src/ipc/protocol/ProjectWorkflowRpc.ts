import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  ProjectWorkflow,
  ProjectWorkflowMutation,
  ProjectWorkflowSessionDetails,
  ProjectWorkflowSessionDestination,
} from "../../domain/application-data";
import { ProjectError } from "../../domain/project-error";

export const ProjectWorkflowRpc = RpcGroup.make(
  Rpc.make("projectWorkflow.mutate", {
    payload: Schema.Struct({
      projectPath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
      mutation: ProjectWorkflowMutation,
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
