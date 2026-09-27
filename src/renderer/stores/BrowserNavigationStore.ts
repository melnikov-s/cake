import { Store, observable } from "r-state-tree";
import type { RootProjection } from "../models/RootProjection";
import type { SavedDraft } from "../../domain/project-sessions/saved-draft-data";

/** Tab-local selection and loaded identities. No persistence or shared draft authority.
 * Selection is latest intent wins; loaded chats retain their own unsent text until tab close.
 */
export class BrowserNavigationStore extends Store<{
  projection: RootProjection;
  savedDrafts(): ReadonlyArray<SavedDraft>;
}> {
  projectPath: string | undefined;
  sessionId: string | undefined;
  readonly synchronizedProjects = observable(new Set<string>());
  readonly opened = observable<
    Array<{ sessionId: string; projectPath: string; workingDirectory: string; staged: boolean }>
  >([]);

  get projects() {
    return this.props.projection.projects.projects;
  }
  get sessions() {
    return this.props.projection.sessionCatalog.sessions.filter(
      (session) => session.projectPath === this.projectPath && !session.resolved,
    );
  }
  get savedDraftSessions() {
    return this.props
      .savedDrafts()
      .filter((record) => record.projectPath === this.projectPath && record.status !== "activated");
  }
  get unsentSessions() {
    return this.opened.filter(
      (target) =>
        target.projectPath === this.projectPath &&
        target.staged &&
        !this.props.projection.sessionCatalog.find(target.sessionId) &&
        !this.props.savedDrafts().some((draft) => draft.sessionId === target.sessionId),
    );
  }
  selectProject(path: string) {
    this.projectPath = path;
    this.sessionId = undefined;
  }
  selectSession(sessionId: string) {
    const summary = this.props.projection.sessionCatalog.find(sessionId);
    if (!summary) {
      const saved = this.props
        .savedDrafts()
        .find((record) => record.sessionId === sessionId && record.status !== "activated");
      if (saved) {
        this.retain({
          sessionId,
          projectPath: saved.projectPath,
          workingDirectory: saved.projectPath,
          staged: true,
        });
        return true;
      }
      const retained = this.opened.find((entry) => entry.sessionId === sessionId);
      if (retained) {
        this.projectPath = retained.projectPath;
        this.sessionId = sessionId;
        return true;
      }
      return false;
    }
    this.retain({
      sessionId,
      projectPath: summary.projectPath,
      workingDirectory: summary.workingDirectory,
      staged: false,
    });
    return true;
  }
  materializeSavedDraft(record: SavedDraft) {
    const index = this.opened.findIndex((entry) => entry.sessionId === record.sessionId);
    if (index >= 0)
      this.opened[index] = {
        sessionId: record.sessionId,
        projectPath: record.projectPath,
        workingDirectory: record.workingDirectory,
        staged: false,
      };
  }
  newChat() {
    if (!this.projectPath) return;
    this.retain({
      sessionId: crypto.randomUUID(),
      projectPath: this.projectPath,
      workingDirectory: this.projectPath,
      staged: true,
    });
  }
  private retain(target: BrowserNavigationStore["opened"][number]) {
    if (!this.opened.some((entry) => entry.sessionId === target.sessionId))
      this.opened.push(target);
    this.projectPath = target.projectPath;
    this.sessionId = target.sessionId;
  }
}
