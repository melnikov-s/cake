import { Model, child, observable } from "r-state-tree";
import { SessionSummary } from "./SessionSummary";

export class SessionCatalog extends Model {
  @child(SessionSummary) sessions: SessionSummary[] = observable([]);

  find(sessionId: string) {
    return this.sessions.find((session) => session.sessionId === sessionId);
  }

  projectSessions(projectPath: string): readonly SessionSummary[] {
    return this.sessions.filter((session) => session.projectPath === projectPath);
  }

  upsertPending(input: {
    readonly sessionId: string;
    readonly projectPath: string;
    readonly projectName: string;
    readonly workingDirectory: string;
    readonly draft?: boolean;
    readonly resolved?: boolean;
  }) {
    const existing = this.find(input.sessionId);
    if (existing && !existing.pending)
      throw new Error(`Session ID collision detected: ${input.sessionId}`);
    const now = new Date().toISOString();
    const session =
      existing ??
      SessionSummary.create({
        sessionId: input.sessionId,
        title: "New chat",
        createdAt: now,
        modifiedAt: now,
        messageCount: 0,
        resolved: input.resolved ?? false,
        unread: false,
        projectPath: input.projectPath,
        projectName: input.projectName,
        workingDirectory: input.workingDirectory,
        pending: true,
        draft: input.draft ?? false,
      });
    if (!existing) this.sessions.push(session);
    session.modifiedAt = now;
    session.resolved = input.resolved ?? session.resolved;
    session.draft = input.draft ?? session.draft;
    session.pending = true;
  }

  removePending(sessionId: string) {
    const session = this.find(sessionId);
    if (!session?.pending) return;
    this.sessions.splice(this.sessions.indexOf(session), 1);
  }
}
