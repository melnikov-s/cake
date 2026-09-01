import { Store } from "r-state-tree";
import { RendererClientContext } from "../client/RendererClientContext";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";

export interface SessionManagementStoreProps {
  operations: SessionOperationCoordinatorStore;
  catalog: SessionCatalogStore;
  registry: SessionRegistryStore;
  prepareResolution?(sessionIds: readonly string[]): Promise<boolean>;
  reportError(error: unknown): void;
}

/** Owns Project Session rename, archive/restore, deletion, and unread commands. */
export class SessionManagementStore extends Store<SessionManagementStoreProps> {
  get client() {
    return RendererClientContext.consume(this)!;
  }

  async renameSession(sessionId: string, name: string) {
    const title = name.trim();
    if (!title || this.signal.aborted) return;
    if (this.props.registry.isTemporarySession(sessionId)) {
      this.props.registry.setPendingName(sessionId, title);
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
    if (!this.props.catalog.find(sessionId) || this.signal.aborted) return false;
    if (resolved && !(await (this.props.prepareResolution?.([sessionId]) ?? true))) return false;
    if (this.signal.aborted) return false;
    if (this.props.registry.setDraftSessionResolved(sessionId, resolved)) return true;
    if (resolved && this.props.registry.isTemporarySession(sessionId)) {
      this.props.registry.removeSession(sessionId);
      return true;
    }
    try {
      const target = { sessionId };
      if (resolved) await this.client.projectSessions.resolve(target, { signal: this.signal });
      else await this.client.projectSessions.restore(target, { signal: this.signal });
      return !this.signal.aborted;
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
      return false;
    }
  }

  async deleteSession(sessionId: string) {
    if (!this.props.catalog.find(sessionId)?.resolved || this.signal.aborted) return;
    try {
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
    if (resolved && !(await (this.props.prepareResolution?.(sessionIds) ?? true))) return 0;
    if (this.signal.aborted) return 0;
    let resolvedCount = 0;
    for (const sessionId of sessionIds) {
      if (await this.resolveSession(sessionId, resolved)) resolvedCount += 1;
    }
    return resolvedCount;
  }
}
