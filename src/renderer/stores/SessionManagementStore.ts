import { Store, observable } from "r-state-tree";
import { SESSION_TITLE_MAX_LENGTH } from "../../contracts/conversations/session-contract";
import { ClientContext } from "./context/ClientContext";
import { ClientError } from "../client/Client";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { SessionRegistryContext } from "./context/SessionRegistryContext";
import { ProjectCatalogContext } from "./context/ProjectCatalogContext";
import { ProjectPendingSessionsContext } from "./context/ProjectPendingSessionsContext";
import type { SessionLabel } from "../../contracts/application/application-data";

export interface SessionManagementStoreProps {
  operations: SessionOperationCoordinatorStore;
  catalog: SessionCatalogStore;
  globalLabels(): ReadonlyArray<SessionLabel>;
  reportError(error: unknown): void;
}

/** Owns Project Session rename, labels, archive/restore, deletion, and unread commands. */
export class SessionManagementStore extends Store<SessionManagementStoreProps> {
  private readonly transitioningSessionIds = observable(new Set<string>());
  /** Unread reminders this window's user set; finished-turn unread is the backend's. */
  private readonly userMarkedUnreadIds = new Set<string>();

  get client() {
    return ClientContext.consume(this)!;
  }

  private get registry() {
    return SessionRegistryContext.consume(this)!;
  }

  private get projects() {
    return ProjectCatalogContext.consume(this)!;
  }

  private get pending() {
    return ProjectPendingSessionsContext.consume(this)!;
  }

  /** Restores a resolved session before submission; active sessions need no mutation. */
  ensureSessionActive(sessionId: string) {
    return this.props.catalog.find(sessionId)?.resolved === true
      ? this.resolveSession(sessionId, false)
      : true;
  }

  async renameSession(sessionId: string, name: string) {
    const title = name.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
    if (!title || this.signal.aborted) return;
    if (this.pending.savedRecord(sessionId)?.status === "activating") return;
    if (this.pending.isDraft(sessionId)) {
      try {
        await this.pending.updateSavedMetadata(sessionId, { title });
      } catch (error) {
        if (!this.signal.aborted) this.props.reportError(error);
      }
      return;
    }
    if (this.pending.isTemporary(sessionId)) {
      this.pending.conversation(sessionId)?.setName(title);
      return;
    }
    const operationId = this.props.operations.start("project-workbench");
    try {
      await this.client.projectSessions.rename({ sessionId, name: title }, { signal: this.signal });
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
    } finally {
      this.props.operations.finish(operationId);
    }
  }

  async resolveSession(
    sessionId: string,
    resolved: boolean,
    onResolved?: (sessionIds: readonly string[]) => Promise<void> | void,
  ) {
    const session = this.props.catalog.find(sessionId);
    if (!session || this.signal.aborted) return false;
    if (this.pending.savedRecord(sessionId)?.status === "activating") return false;
    if (this.pending.isDraft(sessionId)) {
      try {
        await this.pending.updateSavedMetadata(sessionId, { resolved });
        if (this.signal.aborted) return false;
        if (resolved) await onResolved?.([sessionId]);
        return !this.signal.aborted;
      } catch (error) {
        if (!this.signal.aborted) this.props.reportError(error);
        return false;
      }
    }
    if (this.pending.conversation(sessionId)?.setDraftResolved(resolved)) {
      if (resolved) await onResolved?.([sessionId]);
      return !this.signal.aborted;
    }
    if (resolved && this.pending.isTemporary(sessionId)) {
      this.registry.removeSession(sessionId);
      await onResolved?.([sessionId]);
      return !this.signal.aborted;
    }
    if (session.familyParentSessionId && session.familyParentSessionId !== sessionId) return false;
    const transitionSessionId = session.sessionId;
    if (this.transitioningSessionIds.has(transitionSessionId)) return false;
    this.transitioningSessionIds.add(transitionSessionId);
    const resolutionSessionIds = session.familyId
      ? this.props.catalog.sessions
          .filter((member) => member.familyId === session.familyId)
          .map((member) => member.sessionId)
      : [sessionId];
    try {
      if (this.signal.aborted) return false;
      const target = {
        sessionId: transitionSessionId,
        workingDirectory: session.workingDirectory,
      };
      if (resolved) await this.client.projectSessions.resolve(target, { signal: this.signal });
      else await this.client.projectSessions.restore(target, { signal: this.signal });
      if (this.signal.aborted) return false;
      if (resolved) await onResolved?.(resolutionSessionIds);
      return !this.signal.aborted;
    } catch (error) {
      if (this.signal.aborted) return false;
      const failure = error instanceof ClientError ? error.domainFailure : undefined;
      if (resolved && failure?._tag === "ResolutionCleanupFailed") {
        await onResolved?.(failure.resolvedSessionIds);
        if (this.signal.aborted) return false;
        this.props.reportError(
          new Error(
            failure.cleanupFailures
              .map(
                (cleanup) =>
                  `Sessions resolved; cleanup failed for ${cleanup.workingDirectory}: ${cleanup.message}`,
              )
              .join("\n"),
          ),
        );
        return true;
      }
      this.props.reportError(error);
      return false;
    } finally {
      this.transitioningSessionIds.delete(transitionSessionId);
    }
  }

  areLabelsPending(sessionId: string) {
    return this.transitioningSessionIds.has(sessionId);
  }

  async setSessionLabels(sessionId: string, labelIds: readonly string[]) {
    const session = this.props.catalog.find(sessionId);
    const pendingSession = this.registry.findSession(sessionId);
    const projectPath =
      session?.projectPath ??
      (pendingSession
        ? this.props.catalog.projectPathFor(pendingSession.workspacePath)
        : undefined);
    if (!projectPath || session?.resolved || this.signal.aborted) return false;
    if (this.pending.savedRecord(sessionId)?.status === "activating") return false;
    if (this.transitioningSessionIds.has(sessionId)) return false;
    const project = this.projects.find(projectPath);
    if (!project) return false;
    const availableIds = new Set(
      [...this.props.globalLabels(), ...project.workflow.labels].map((label) => label.id),
    );
    if (labelIds.some((labelId) => !availableIds.has(labelId))) {
      this.props.reportError(new Error("A selected label no longer exists"));
      return false;
    }

    this.transitioningSessionIds.add(sessionId);
    try {
      if (this.pending.isDraft(sessionId)) {
        await this.pending.updateSavedMetadata(sessionId, {
          labelIds: [...labelIds],
        });
        return !this.signal.aborted;
      }
      if (this.pending.isTemporary(sessionId)) {
        await this.pending.setLabels(sessionId, labelIds);
        return !this.signal.aborted;
      }
      if (!session) return false;
      await this.client.projectWorkflow.setSessionLabels(
        { projectPath, sessionId, workingDirectory: session.workingDirectory, labelIds },
        { signal: this.signal },
      );
      return !this.signal.aborted;
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
      return false;
    } finally {
      this.transitioningSessionIds.delete(sessionId);
    }
  }

  async deleteSession(sessionId: string) {
    if (!this.props.catalog.find(sessionId)?.resolved || this.signal.aborted) return;
    try {
      if (this.pending.isDraft(sessionId)) {
        await this.pending.deleteResolvedDraft(sessionId);
        return;
      }
      await this.client.workspaces.deleteSession(sessionId, { signal: this.signal });
      if (!this.signal.aborted) this.registry.removeSession(sessionId);
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
    }
  }

  isUserMarkedUnread(sessionId: string) {
    return this.userMarkedUnreadIds.has(sessionId);
  }

  async setSessionUnread(sessionId: string, unread: boolean) {
    if (!this.props.catalog.find(sessionId) || this.signal.aborted) return;
    if (unread) this.userMarkedUnreadIds.add(sessionId);
    else this.userMarkedUnreadIds.delete(sessionId);
    try {
      await this.client.workspaces.setSessionUnread(sessionId, unread, { signal: this.signal });
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
    }
  }

  async resolveSessionsById(
    sessionIds: readonly string[],
    resolved: boolean,
    onResolved?: (sessionIds: readonly string[]) => Promise<void> | void,
  ) {
    if (this.signal.aborted) return 0;
    const requestedIds = new Set(sessionIds);
    const plans = new Map<string, number>();
    for (const sessionId of requestedIds) {
      const session = this.props.catalog.find(sessionId);
      const parentSessionId = session?.familyParentSessionId;
      const targetSessionId =
        parentSessionId && parentSessionId !== sessionId && requestedIds.has(parentSessionId)
          ? parentSessionId
          : sessionId;
      plans.set(targetSessionId, (plans.get(targetSessionId) ?? 0) + 1);
    }
    let resolvedCount = 0;
    for (const [sessionId, requestedCount] of plans) {
      if (await this.resolveSession(sessionId, resolved, onResolved))
        resolvedCount += requestedCount;
    }
    return resolvedCount;
  }
}
