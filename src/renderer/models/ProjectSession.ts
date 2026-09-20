import { Model, id, observable } from "r-state-tree";
import type { ProjectSessionProjection } from "../../domain/project-sessions/project-session-data";

/** Renderer projection of the thin main-owned Project Session aggregate read. */
export class ProjectSession extends Model {
  @id sessionId = "";
  projectPath = "";
  projectName = "";
  workingDirectory = "";
  resolved = false;
  unread = false;
  primaryConversationId = "";
  discussionSessions: ProjectSessionProjection["discussionSessions"] = observable([]);
  subagentSessions: ProjectSessionProjection["subagentSessions"] = observable([]);
  reviewThreads: ProjectSessionProjection["reviewThreads"] = observable([]);
  artifactLinks: ProjectSessionProjection["artifactLinks"] = observable([]);
  family: ProjectSessionProjection["family"] = undefined;
  loadedRevision = 0;
  /** Focused authorities increment this only when aggregate membership may have changed. */
  invalidationRevision = 0;
}
