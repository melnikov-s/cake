import { Store } from "r-state-tree";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import type { AppShellStore, SessionHistoryEntry } from "./AppShellStore";
import { ClientContext } from "./context/ClientContext";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import { ProjectSessionNavigationContext } from "./context/ProjectSessionNavigationContext";
import { ProjectOpenContext } from "./context/ProjectOpenContext";

export interface ProjectRemovalStoreProps {
  catalog: SessionCatalogStore;
  cakeChat(): CakeChatCollectionStore;
  registry: SessionRegistryStore;
  shell: AppShellStore;
  focusedProjectPath(): string | undefined;
  leaveProjectFocus(): void;
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
      if (!this.signal.aborted) ProjectSessionNavigationContext.consume(this)!.setError(error);
      return false;
    }

    ProjectOpenContext.consume(this)!.clear(path);
    if (this.props.focusedProjectPath() === path) this.props.leaveProjectFocus();
    const target = this.props.shell.removeSessionsFromHistory(sessionIds);
    chat.sessionLayoutStore.removeSessions(chatIds);
    for (const sessionId of chatIds) chat.registry.remove(sessionId);
    if (deleteSessions)
      for (const sessionId of sessionIds) this.props.registry.removeSession(sessionId);
    if (target) await this.props.navigate(target);
    else if (
      (this.props.shell.selection.kind === "project-session" ||
        this.props.shell.selection.kind === "cake-chat") &&
      this.props.shell.selection.sessionId !== undefined &&
      sessionIds.includes(this.props.shell.selection.sessionId)
    )
      this.props.showEmptyWorkbench();
    return true;
  }
}
