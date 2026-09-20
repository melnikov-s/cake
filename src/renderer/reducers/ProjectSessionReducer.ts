import { batch } from "r-state-tree";
import type { ProjectSessionProjection } from "../../domain/project-sessions/project-session-data";
import type { ProjectSession } from "../models/ProjectSession";

export function applyProjectSessionProjection(
  model: ProjectSession,
  projection: ProjectSessionProjection,
) {
  if (
    projection.identity._tag !== "ProjectSession" ||
    projection.identity.sessionId !== model.sessionId
  )
    throw new Error(`Project Session projection identity collision: ${model.sessionId}`);
  batch(() => {
    model.projectPath = projection.project.path;
    model.projectName = projection.project.name;
    model.workingDirectory = projection.workingDirectory.path;
    model.resolved = projection.lifecycle.resolved;
    model.unread = projection.lifecycle.unread;
    model.primaryConversationId = projection.primaryConversation.sessionId;
    model.discussionSessions = [...projection.discussionSessions];
    model.subagentSessions = [...projection.subagentSessions];
    model.reviewThreads = [...projection.reviewThreads];
    model.artifactLinks = [...projection.artifactLinks];
    model.family = projection.family;
    model.loadedRevision += 1;
  });
}
