import { computed, Store } from "r-state-tree";
import { isActiveSessionActivity } from "../lib/session-activity";
import type { SessionLabel } from "../../contracts/application/application-data";
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
  workingDirectory(sessionId: string) {
    return (
      this.props.catalog.find(sessionId)?.workingDirectory ??
      this.props.sessions.findSession(sessionId)?.workspacePath
    );
  }

  exists(sessionId: string) {
    return !!(this.props.catalog.find(sessionId) || this.props.sessions.findSession(sessionId));
  }

  isResolved(sessionId: string) {
    return this.props.catalog.find(sessionId)?.resolved === true;
  }

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
        ? this.props.catalog.projectPathFor(pendingSession.workspacePath)
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

  /** Sparse active membership for list ordering, without loading/querying every session. */
  @computed
  get activeSessionIds() {
    const ids = new Set(
      this.props.catalog.sessions
        .filter((session) => session.running)
        .map((session) => session.sessionId),
    );
    for (const session of this.props.sessions.sessions) {
      if (isActiveSessionActivity(session.activity)) ids.add(session.sessionId);
    }
    for (const operation of this.props.worktreeOperations?.operations ?? []) {
      if (
        operation.kind === "landing" &&
        (operation.phase === "waiting" || operation.phase === "queued")
      )
        ids.add(operation.sessionId);
    }
    return ids;
  }

  sessionActivity(sessionId: string): SessionActivity | undefined {
    const session = this.props.catalog.find(sessionId);
    // A blocked journal is authoritative even if a retained projection still has
    // the accepted turn id from before the restart.
    if (session && "recoveryIssue" in session && session.recoveryIssue && !session.running)
      return "blocked";
    if (session && "latestTurnOutcome" in session && !session.running) {
      if (session.latestTurnOutcome === "failed") return "error";
      if (session.latestTurnOutcome === "aborted") return "stopped";
    }
    const activity = this.props.sessions.findSession(sessionId)?.activity;
    if (activity === "waiting" || activity === "running") return activity;
    if (this.activeSessionIds.has(sessionId)) return "running";
    return activity ?? (this.props.catalog.find(sessionId)?.unread ? "unread" : undefined);
  }
}
