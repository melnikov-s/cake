import { CakeChatCatalog } from "./models/CakeChatCatalog";
import { ProjectCatalog } from "./models/ProjectCatalog";
import { Session } from "./models/Session";
import { SessionCatalog } from "./models/SessionCatalog";

/** Owns the renderer window's passive projection Models independently of the Store tree. */
export class RendererModels implements Disposable {
  readonly projects = ProjectCatalog.create();
  readonly sessionCatalog = SessionCatalog.create();
  readonly cakeChatCatalog = CakeChatCatalog.create();
  private readonly projectSessions = new Map<string, Session>();
  private readonly cakeChats = new Map<string, Session>();
  private disposed = false;

  projectSession(sessionId: string, workingDirectory: string) {
    const existing = this.projectSessions.get(sessionId);
    if (existing) return existing;
    const model = Session.create({ sessionId, workingDirectory });
    this.projectSessions.set(sessionId, model);
    return model;
  }

  cakeChat(sessionId: string) {
    const existing = this.cakeChats.get(sessionId);
    if (existing) return existing;
    const model = Session.create({ sessionId });
    this.cakeChats.set(sessionId, model);
    return model;
  }

  [Symbol.dispose]() {
    if (this.disposed) return;
    this.disposed = true;
    for (const model of this.projectSessions.values()) model[Symbol.dispose]();
    for (const model of this.cakeChats.values()) model[Symbol.dispose]();
    this.projects[Symbol.dispose]();
    this.sessionCatalog[Symbol.dispose]();
    this.cakeChatCatalog[Symbol.dispose]();
    this.projectSessions.clear();
    this.cakeChats.clear();
  }
}
