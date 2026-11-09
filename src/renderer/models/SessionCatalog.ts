import { Model, child, findModelById, observable } from "r-state-tree";
import { SessionSignals } from "./SessionSignals";
import { SessionSummary } from "./SessionSummary";

/** Passive authoritative Project Session catalog projection. */
export class SessionCatalog extends Model {
  @child(SessionSummary) sessions: SessionSummary[] = observable([]);
  @child(SessionSignals) signals = SessionSignals.create();
  resolvedHasMoreByProject: Record<string, boolean> = observable({});

  find(sessionId: string): SessionSummary | undefined {
    // The tree maintains its reactive @id index across attach/detach and ID edits.
    // Read empty membership too: the first attachment creates the index bucket.
    if (this.sessions.length === 0) return undefined;
    const session = findModelById(this, SessionSummary, sessionId);
    // Identifier lookup is tree-wide; never return a sibling catalog's summary.
    return session?.parent === this ? session : undefined;
  }

  projectSessions(projectPath: string): readonly SessionSummary[] {
    return this.sessions.filter((session) => session.projectPath === projectPath);
  }
}
