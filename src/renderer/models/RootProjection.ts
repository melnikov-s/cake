import { Model, child, observable } from "r-state-tree";
import { LlmModel } from "./LlmModel";
import { Resource } from "./Resource";
import { CakeChatCatalog } from "./CakeChatCatalog";
import { ProjectCatalog } from "./ProjectCatalog";
import { Session } from "./Session";
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
  @child(Session) projectSessions: Session[] = observable([]);
  @child(Session) cakeChats: Session[] = observable([]);

  projectSession(sessionId: string, workingDirectory: string) {
    const existing = this.findProjectSession(sessionId);
    if (existing) return existing;
    const session = Session.create({ sessionId, workingDirectory });
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
    const session = Session.create({ sessionId });
    this.cakeChats.push(session);
    return session;
  }

  removeCakeChat(sessionId: string) {
    const index = this.cakeChats.findIndex((session) => session.sessionId === sessionId);
    if (index >= 0) this.cakeChats.splice(index, 1);
  }
}
