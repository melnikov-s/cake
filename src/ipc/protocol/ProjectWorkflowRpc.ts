import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  ProjectWorkflow,
  SessionLabel,
  SessionLabelMutation,
  ProjectWorkflowSessionDetails,
} from "../../domain/application/application-data";
import { ProjectError } from "../../domain/projects/project-error";

export const ProjectWorkflowRpc = RpcGroup.make(
  Rpc.make("projectWorkflow.mutateGlobal", {
    payload: Schema.Struct({ mutation: SessionLabelMutation }),
    success: Schema.Array(SessionLabel),
    error: ProjectError,
  }),
  Rpc.make("projectWorkflow.mutate", {
    payload: Schema.Struct({
      projectPath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
      mutation: SessionLabelMutation,
    }),
    success: ProjectWorkflow,
    error: ProjectError,
  }),
  Rpc.make("projectWorkflow.setSessionLabels", {
    payload: Schema.Struct({
      projectPath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
      sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      workingDirectory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
      labelIds: Schema.Array(Schema.String.check(Schema.isUUID(4))).check(
        Schema.isMaxLength(100),
        Schema.isUnique(),
      ),
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
