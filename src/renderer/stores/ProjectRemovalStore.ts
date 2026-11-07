import { Store, batch } from "r-state-tree";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import type { AppShellStore, SessionHistoryEntry } from "./AppShellStore";
import { ClientContext } from "./context/ClientContext";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SessionLayoutStore } from "./SessionLayoutStore";
import { ProjectSessionNavigationContext } from "./context/ProjectSessionNavigationContext";
import { ProjectOpenContext } from "./context/ProjectOpenContext";

export interface ProjectRemovalStoreProps {
  catalog: SessionCatalogStore;
  cakeChat(): CakeChatCollectionStore;
  registry: SessionRegistryStore;
  layout: SessionLayoutStore;
  shell: AppShellStore;
  navigate(target: SessionHistoryEntry): Promise<void>;
  showEmptyWorkbench(): void;
}

/**
 * Owns Project deregistration and optional session-deletion cleanup for this window.
 * Application/main owns the registered Project and terminal/runtime shutdown transaction; this
 * window-scoped Store retires renderer registry and navigation state after command acceptance.
 */
export class ProjectRemovalStore extends Store<ProjectRemovalStoreProps> {
  private get client() {
    return ClientContext.consume(this)!;
  }

  async remove(path: string, deleteSessions: boolean) {
    const chat = this.props.cakeChat();
    const chatIds = chat.summaries
      .filter((session) => session.projectPath === path)
      .map((session) => session.sessionId);
    const sessionIds = [
      ...this.props.catalog.projectSessions(path).map((session) => session.sessionId),
      ...chatIds,
    ];
    try {
      await this.client.workspaces.removeProject(path, deleteSessions, { signal: this.signal });
      if (this.signal.aborted) return false;
    } catch (error) {
      if (this.signal.aborted) return false;
      ProjectSessionNavigationContext.consume(this)!.setError(error);
      throw error;
    }

    const target = batch(() => {
      const selection = this.props.shell.selection;
      const selectedRemoved =
        (selection.kind === "project-session" || selection.kind === "cake-chat") &&
        selection.sessionId !== undefined &&
        sessionIds.includes(selection.sessionId);
      ProjectOpenContext.consume(this)!.clear(path);
      const fallback = this.props.shell.removeSessionsFromHistory(sessionIds);
      this.props.layout.removeSessions(sessionIds);
      chat.sessionLayoutStore.removeSessions(chatIds);
      for (const sessionId of chatIds) chat.registry.remove(sessionId);
      // Removing a renderer identity releases observation, not the saved Pi session.
      for (const sessionId of sessionIds) this.props.registry.removeSession(sessionId);
      if (selectedRemoved) this.props.showEmptyWorkbench();
      return fallback;
    });
    // The confirmation belongs to removal, not acquisition of another conversation.
    if (target) void this.navigateAfterRemoval(target);
    return true;
  }

  private async navigateAfterRemoval(target: SessionHistoryEntry) {
    try {
      await this.props.navigate(target);
    } catch (error) {
      if (!this.signal.aborted) ProjectSessionNavigationContext.consume(this)!.setError(error);
    }
  }
}
