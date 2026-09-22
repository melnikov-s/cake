import { Store } from "r-state-tree";
import type { SessionLabel } from "../../domain/application/application-data";
import type { WorktreeOperationCatalog } from "../models/WorktreeOperationCatalog";
import type { SessionActivity } from "../lib/session-activity";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";

/** Joins shared Project Session labels and live activity for every renderer surface. */
export class SessionMetadataStore extends Store<{
  projects: ProjectCatalogStore;
  catalog: SessionCatalogStore;
  sessions: SessionRegistryStore;
  worktreeOperations?: WorktreeOperationCatalog;
  globalLabels(): ReadonlyArray<SessionLabel>;
}> {
  projectLabels(projectPath: string) {
    const local = this.props.projects.find(projectPath)?.workflow.labels ?? [];
    return [...this.props.globalLabels(), ...local];
  }

  availableSessionLabels(sessionId: string) {
    const session = this.props.catalog.find(sessionId);
    const pendingSession = this.props.sessions.findSession(sessionId);
    const projectPath =
      session?.projectPath ??
      (pendingSession
        ? (this.props.catalog.projectOfManagedWorktree(pendingSession.workspacePath) ??
          pendingSession.workspacePath)
        : undefined);
    return projectPath ? this.projectLabels(projectPath) : [];
  }

  sessionLabelIds(sessionId: string): readonly string[] {
    const availableIds = new Set(this.availableSessionLabels(sessionId).map((label) => label.id));
    if (this.props.sessions.pendingSessions.isTemporary(sessionId))
      return (this.props.sessions.pendingSessions.conversation(sessionId)?.labelIds ?? []).filter(
        (labelId) => availableIds.has(labelId),
      );
    const session = this.props.catalog.find(sessionId);
    if (!session || session.resolved) return [];
    const assignment = this.props.projects
      .find(session.projectPath)
      ?.workflow.assignments.find((candidate) => candidate.sessionId === sessionId);
    return (assignment?.labelIds ?? []).filter((labelId) => availableIds.has(labelId));
  }

  sessionLabels(sessionId: string) {
    const byId = new Map(this.availableSessionLabels(sessionId).map((label) => [label.id, label]));
    return this.sessionLabelIds(sessionId).flatMap((labelId) => {
      const label = byId.get(labelId);
      return label ? [label] : [];
    });
  }

  sessionActivity(sessionId: string): SessionActivity | undefined {
    const activity = this.props.sessions.findSession(sessionId)?.activity;
    if (activity) return activity;
    const waitingToMerge = this.props.worktreeOperations?.operations.some(
      (operation) =>
        operation.sessionId === sessionId &&
        operation.kind === "landing" &&
        operation.phase === "waiting",
    );
    if (waitingToMerge) return "running";
    return this.props.catalog.find(sessionId)?.unread ? "unread" : undefined;
  }
}
