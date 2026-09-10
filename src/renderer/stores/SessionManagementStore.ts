import { Store } from "r-state-tree";
import { SESSION_TITLE_MAX_LENGTH } from "../../ipc/session-contract";
import { ClientContext } from "./context/ClientContext";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";

export interface SessionManagementStoreProps {
  operations: SessionOperationCoordinatorStore;
  catalog: SessionCatalogStore;
  registry: SessionRegistryStore;
  reportError(error: unknown): void;
}

/** Owns Project Session rename, archive/restore, deletion, and unread commands. */
export class SessionManagementStore extends Store<SessionManagementStoreProps> {
  private readonly resolvingSessionIds = new Set<string>();

  get client() {
    return ClientContext.consume(this)!;
  }

  async renameSession(sessionId: string, name: string) {
    const title = name.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
    if (!title || this.signal.aborted) return;
    if (this.props.registry.pendingSessions.isTemporary(sessionId)) {
      this.props.registry.pendingSessions.conversation(sessionId)?.setName(title);
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

  async resolveSession(sessionId: string, resolved: boolean) {
    const session = this.props.catalog.find(sessionId);
    if (!session || this.signal.aborted) return false;
    if (this.props.registry.pendingSessions.conversation(sessionId)?.setDraftResolved(resolved))
      return true;
    if (resolved && this.props.registry.pendingSessions.isTemporary(sessionId)) {
      this.props.registry.removeSession(sessionId);
      return true;
    }
    const transitionSession =
      session.familyParentSessionId && session.familyParentSessionId !== sessionId
        ? this.props.catalog.find(session.familyParentSessionId)
        : session;
    if (!transitionSession) return false;
    const transitionSessionId = transitionSession.sessionId;
    if (this.resolvingSessionIds.has(transitionSessionId)) return false;
    this.resolvingSessionIds.add(transitionSessionId);
    try {
      if (this.signal.aborted) return false;
      const target = {
        sessionId: transitionSessionId,
        workingDirectory: transitionSession.workingDirectory,
      };
      if (resolved) await this.client.projectSessions.resolve(target, { signal: this.signal });
      else await this.client.projectSessions.restore(target, { signal: this.signal });
      return !this.signal.aborted;
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
      return false;
    } finally {
      this.resolvingSessionIds.delete(transitionSessionId);
    }
  }

  async deleteSession(sessionId: string) {
    if (!this.props.catalog.find(sessionId)?.resolved || this.signal.aborted) return;
    try {
      if (this.props.registry.pendingSessions.isDraft(sessionId)) {
        await this.props.registry.pendingSessions.deleteResolvedDraft(sessionId);
        return;
      }
      await this.client.workspaces.deleteSession(sessionId, { signal: this.signal });
      if (!this.signal.aborted) this.props.registry.removeSession(sessionId);
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
    }
  }

  async setSessionUnread(sessionId: string, unread: boolean) {
    if (!this.props.catalog.find(sessionId) || this.signal.aborted) return;
    try {
      await this.client.workspaces.setSessionUnread(sessionId, unread, { signal: this.signal });
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
    }
  }

  async resolveSessionsById(sessionIds: readonly string[], resolved: boolean) {
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
      if (await this.resolveSession(sessionId, resolved)) resolvedCount += requestedCount;
    }
    return resolvedCount;
  }
}
