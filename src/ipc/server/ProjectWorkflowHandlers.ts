import * as projects from "../../domain/projects";
import { ProjectWorkflowRpc } from "../protocol/ProjectWorkflowRpc";

export const projectWorkflowHandlers = ProjectWorkflowRpc.of({
  "projectWorkflow.mutate": (request) => projects.mutateWorkflow(request),
  "projectWorkflow.describeSession": (request) => projects.describeWorkflowSession(request),
});
