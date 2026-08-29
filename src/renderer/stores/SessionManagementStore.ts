import { Store, observable } from "r-state-tree";
import type { ApplicationState } from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";

export interface SessionManagementStoreProps {
  client: Pick<
    DesktopClient,
    "renameSession" | "resolveSession" | "resolveSessions" | "setSessionUnread"
  >;
  operations: SessionOperationCoordinatorStore;
  catalog: SessionCatalogStore;
  registry: SessionRegistryStore;
  applyApplicationState(state: ApplicationState): void;
  reportError(error: unknown): void;
}

/** Owns session rename rollback, resolved state, and resolution-time worktree cleanup. */
export class SessionManagementStore extends Store<SessionManagementStoreProps> {
  private readonly pendingRenames: Record<string, { sessionId: string; previousTitle: string }> =
    observable({});

  constructor(props: SessionManagementStore["props"]) {
    super(props);
    this.effect(() => () => {
      for (const operationId of Object.keys(this.pendingRenames)) {
        this.rollbackRename(operationId);
        this.props.operations.finish(operationId);
      }
    });
  }

  async renameSession(sessionId: string, name: string) {
    if (!name.trim() || this.signal.aborted) return;
    const title = name.trim();
    if (this.props.registry.isTemporarySession(sessionId)) {
      this.props.registry.setPendingName(sessionId, title);
      return;
    }
    const operationId = this.props.operations.start("project-workbench");
    try {
      const previousTitle = this.props.catalog.rename(sessionId, title);
      if (previousTitle !== undefined)
        this.pendingRenames[operationId] = { sessionId, previousTitle };
      try {
        await this.props.client.renameSession({ operationId, sessionId, name: title });
      } catch (error) {
        if (!this.signal.aborted) this.rollbackRename(operationId);
        throw error;
      }
    } catch (error) {
      if (this.signal.aborted) return;
      this.props.operations.finish(operationId);
      this.props.reportError(error);
    }
  }

  async resolveSession(sessionId: string, resolved: boolean) {
    if (!this.props.catalog.find(sessionId) || this.signal.aborted) return;
    if (this.props.registry.setDraftSessionResolved(sessionId, resolved)) return;
    if (resolved && this.props.registry.isTemporarySession(sessionId)) {
      this.props.registry.discardNewSession(sessionId);
      return;
    }
    try {
      const state = await this.props.client.resolveSession(sessionId, resolved);
      if (!this.signal.aborted) this.props.applyApplicationState(state);
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
    }
  }

  async setSessionUnread(sessionId: string, unread: boolean) {
    if (!this.props.catalog.find(sessionId) || this.signal.aborted) return;
    try {
      const state = await this.props.client.setSessionUnread(sessionId, unread);
      if (!this.signal.aborted) this.props.applyApplicationState(state);
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
    }
  }

  async resolveSessionsById(
    sessionIds: readonly string[],
    resolved: boolean,
    workspacePath?: string,
  ) {
    const persistedIds: string[] = [];
    for (const sessionId of sessionIds) {
      if (!this.props.catalog.find(sessionId))
        throw new Error(`Cake could not find session ${sessionId}`);
      if (this.props.registry.setDraftSessionResolved(sessionId, resolved)) continue;
      if (resolved && this.props.registry.isTemporarySession(sessionId)) {
        this.props.registry.discardNewSession(sessionId);
        continue;
      }
      persistedIds.push(sessionId);
    }
    if (persistedIds.length === 0) return sessionIds.length;
    try {
      const state = await this.props.client.resolveSessions(persistedIds, resolved, workspacePath);
      if (this.signal.aborted) return 0;
      this.props.applyApplicationState(state);
      return sessionIds.length;
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
      throw error;
    }
  }

  receive(event: DesktopClientEvent) {
    if (event.type === "operation-completed") {
      if (!this.pendingRenames[event.operationId]) return;
      delete this.pendingRenames[event.operationId];
      this.props.operations.finish(event.operationId);
      return;
    }
    if (event.type === "operation-failed" && event.operationId) {
      if (!this.pendingRenames[event.operationId]) return;
      this.rollbackRename(event.operationId);
      this.props.operations.finish(event.operationId);
      this.props.reportError(event.message);
      return;
    }
    if (
      event.type === "pi-state-changed" &&
      (event.state === "failed" || event.state === "stopped")
    ) {
      for (const operationId of Object.keys(this.pendingRenames)) {
        this.rollbackRename(operationId);
        this.props.operations.finish(operationId);
      }
    }
  }

  private rollbackRename(operationId: string) {
    const pending = this.pendingRenames[operationId];
    if (!pending) return;
    this.props.catalog.rename(pending.sessionId, pending.previousTitle);
    delete this.pendingRenames[operationId];
  }
}
