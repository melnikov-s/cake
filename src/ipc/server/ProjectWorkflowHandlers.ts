import * as projects from "../../domain/projects/projects";
import { ProjectWorkflowRpc } from "../protocol/ProjectWorkflowRpc";

export const projectWorkflowHandlers = ProjectWorkflowRpc.of({
  "projectWorkflow.mutateGlobal": (request) => projects.mutateGlobalWorkflow(request),
  "projectWorkflow.mutate": (request) => projects.mutateWorkflow(request),
  "projectWorkflow.moveSession": (request) => projects.moveWorkflowSession(request),
  "projectWorkflow.describeSession": (request) => projects.describeWorkflowSession(request),
});
