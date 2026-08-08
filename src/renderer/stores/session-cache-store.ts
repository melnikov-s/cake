import { Store, observable } from "r-state-tree";
import type { SessionPreview, SessionSnapshot } from "../../ipc/session-contract";
import { SessionModel } from "../models/session";

export class SessionCacheStore extends Store<Record<string, never>> {
  readonly sessions: SessionModel[] = observable([]);

  constructor(props: SessionCacheStore["props"]) {
    super(props);
    this.effect(() => () => {
      for (const session of this.sessions) session[Symbol.dispose]();
      this.sessions.splice(0);
    });
  }

  find(sessionId: string, workspacePath?: string) {
    return this.sessions.find((session) => session.sessionId === sessionId && (!workspacePath || session.workspacePath === workspacePath));
  }

  upsert(snapshot: SessionSnapshot) {
    let session = this.find(snapshot.sessionId, snapshot.workspacePath);
    if (!session) {
      session = SessionModel.create();
      this.sessions.push(session);
    }
    session.applySnapshot(snapshot);
    return session;
  }

  hydratePreview(preview: SessionPreview) {
    let session = this.find(preview.sessionId, preview.workspacePath);
    if (!session) {
      session = SessionModel.create();
      this.sessions.push(session);
    }
    session.applyPreview(preview);
    return session;
  }
}
