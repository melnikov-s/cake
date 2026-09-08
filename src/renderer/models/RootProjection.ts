import { Model, child, observable } from "r-state-tree";
import { CakeChatCatalog } from "./CakeChatCatalog";
import { ProjectCatalog } from "./ProjectCatalog";
import { Session } from "./Session";
import { SessionCatalog } from "./SessionCatalog";

/** Owns the authoritative data projections currently loaded in one renderer window. */
export class RootProjection extends Model {
  @child(ProjectCatalog) projects = ProjectCatalog.create();
  @child(SessionCatalog) sessionCatalog = SessionCatalog.create();
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

  cakeChat(sessionId: string) {
    const existing = this.cakeChats.find((session) => session.sessionId === sessionId);
    if (existing) return existing;
    const session = Session.create({ sessionId });
    this.cakeChats.push(session);
    return session;
  }
}
