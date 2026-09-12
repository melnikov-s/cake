import * as projects from "../../domain/projects/projects";
import { ProjectWorkflowRpc } from "../protocol/ProjectWorkflowRpc";

export const projectWorkflowHandlers = ProjectWorkflowRpc.of({
  "projectWorkflow.mutateGlobal": (request) => projects.mutateGlobalWorkflow(request),
  "projectWorkflow.mutate": (request) => projects.mutateWorkflow(request),
  "projectWorkflow.setSessionLabels": (request) => projects.setWorkflowSessionLabels(request),
  "projectWorkflow.describeSession": (request) => projects.describeWorkflowSession(request),
});
