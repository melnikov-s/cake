import type { SessionPurpose } from "../../contracts/project-sessions/session-purpose";
import { Model, computed } from "r-state-tree";
import type { ProjectSessionSignal } from "../../contracts/project-sessions/project-session-signals";

/** Compact background facts, separate from the demand-loaded Sessions catalog. */
export class SessionSignals extends Model {
  loaded = false;
  purposes: Readonly<Record<string, SessionPurpose>> = {};
  sessions: readonly ProjectSessionSignal[] = [];

  @computed
  private get byId() {
    return new Map(this.sessions.map((session) => [session.sessionId, session]));
  }

  find(sessionId: string) {
    return this.byId.get(sessionId);
  }
}
