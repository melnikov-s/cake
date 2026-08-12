import { Store, observable } from "r-state-tree";
import type { SessionPreview, SessionSnapshot } from "../../ipc/session-contract";
import type { ReviewThread } from "../../ipc/review-contract";
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

  private ensure(sessionId: string, workspacePath: string) {
    let session = this.find(sessionId, workspacePath);
    if (!session) {
      session = SessionModel.create({ sessionId, workspacePath });
      this.sessions.push(session);
    }
    return session;
  }

  upsert(snapshot: SessionSnapshot) {
    const session = this.ensure(snapshot.sessionId, snapshot.workspacePath);
    session.applySnapshot(snapshot);
    return session;
  }

  hydratePreview(preview: SessionPreview) {
    const session = this.ensure(preview.sessionId, preview.workspacePath);
    session.applyPreview(preview);
    return session;
  }


  applyReviewThreads(workspacePath: string, sessionId: string, threads: ReviewThread[]) {
    const session = this.ensure(sessionId, workspacePath);
    session.applyReviewThreads(threads);
    return session;
  }

  upsertReviewThread(thread: ReviewThread) {
    const session = this.ensure(thread.sessionId, thread.workspacePath);
    session.upsertReviewThread(thread);
    return session;
  }
}
