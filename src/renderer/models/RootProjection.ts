import { Model, child, observable } from "r-state-tree";
import { LlmModel } from "./LlmModel";
import { ArtifactCatalog } from "./ArtifactCatalog";
import { Resource } from "./Resource";
import { CakeChatCatalog } from "./CakeChatCatalog";
import { ProjectCatalog } from "./ProjectCatalog";
import { CakeSession } from "./CakeSession";
import { SessionCatalog } from "./SessionCatalog";
import { WorktreeCatalog } from "./WorktreeCatalog";
import { WorktreeOperationCatalog } from "./WorktreeOperationCatalog";

/** Owns the authoritative data projections currently loaded in one renderer window. */
export class RootProjection extends Model {
  @child(LlmModel) llmModels: LlmModel[] = observable([]);
  @child(Resource) resources: Resource[] = observable([]);
  @child(ProjectCatalog) projects = ProjectCatalog.create();
  @child(SessionCatalog) sessionCatalog = SessionCatalog.create();
  @child(WorktreeCatalog) worktrees = WorktreeCatalog.create();
  @child(WorktreeOperationCatalog) worktreeOperations = WorktreeOperationCatalog.create();
  @child(CakeChatCatalog) cakeChatCatalog = CakeChatCatalog.create();
  @child(ArtifactCatalog) artifacts = ArtifactCatalog.create();
  @child(CakeSession) projectSessions: CakeSession[] = observable([]);
  @child(CakeSession) cakeChats: CakeSession[] = observable([]);
  /** Live Discussion Session sidecars, keyed by their own Pi Session ID. */
  @child(CakeSession) discussionSessions: CakeSession[] = observable([]);

  projectSession(sessionId: string, workingDirectory: string) {
    const existing = this.findProjectSession(sessionId);
    if (existing) return existing;
    const session = CakeSession.create({ sessionId, workingDirectory });
    this.projectSessions.push(session);
    return session;
  }

  findProjectSession(sessionId: string) {
    return this.projectSessions.find((session) => session.sessionId === sessionId);
  }

  removeProjectSession(sessionId: string) {
    const index = this.projectSessions.findIndex((session) => session.sessionId === sessionId);
    if (index >= 0) this.projectSessions.splice(index, 1);
  }

  cakeChat(sessionId: string) {
    const existing = this.cakeChats.find((session) => session.sessionId === sessionId);
    if (existing) return existing;
    const session = CakeSession.create({ sessionId });
    this.cakeChats.push(session);
    return session;
  }

  removeCakeChat(sessionId: string) {
    const index = this.cakeChats.findIndex((session) => session.sessionId === sessionId);
    if (index >= 0) this.cakeChats.splice(index, 1);
  }

  discussionSession(sessionId: string, workingDirectory: string) {
    const existing = this.findDiscussionSession(sessionId);
    if (existing) return existing;
    const session = CakeSession.create({ sessionId, workingDirectory });
    this.discussionSessions.push(session);
    return session;
  }

  findDiscussionSession(sessionId: string) {
    return this.discussionSessions.find((session) => session.sessionId === sessionId);
  }

  removeDiscussionSession(sessionId: string) {
    const index = this.discussionSessions.findIndex((session) => session.sessionId === sessionId);
    if (index >= 0) this.discussionSessions.splice(index, 1);
  }
}
