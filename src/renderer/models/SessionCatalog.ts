import { Model, child, observable } from "r-state-tree";
import { SessionSummary } from "./SessionSummary";

/** Passive authoritative Project Session catalog projection. */
export class SessionCatalog extends Model {
  @child(SessionSummary) sessions: SessionSummary[] = observable([]);

  find(sessionId: string) {
    return this.sessions.find((session) => session.sessionId === sessionId);
  }

  projectSessions(projectPath: string): readonly SessionSummary[] {
    return this.sessions.filter((session) => session.projectPath === projectPath);
  }
}
