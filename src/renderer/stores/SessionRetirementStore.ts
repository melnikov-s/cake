import { Store } from "r-state-tree";
import type { AppShellStore, SessionHistoryEntry } from "./AppShellStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionLayoutStore } from "./SessionLayoutStore";
import { SessionManagementContext } from "./context/SessionManagementContext";
import type { SessionRegistryStore } from "./SessionRegistryStore";

export interface SessionRetirementStoreProps {
  shell: AppShellStore;
  catalog: SessionCatalogStore;
  registry: SessionRegistryStore;
  layout: SessionLayoutStore;
  navigate(target: SessionHistoryEntry): Promise<void>;
  createProjectSession(projectPath: string): Promise<void>;
  openProjectChat(projectPath: string): Promise<boolean>;
}

/**
 * Owns renderer retirement after authoritative resolve/delete commands.
 * Main/Pi owns lifecycle state; this window-scoped Store owns history, layout, registry, and
 * fallback-navigation cleanup. Transition serialization remains in each focused management Store.
 */
export class SessionRetirementStore extends Store<SessionRetirementStoreProps> {
  private get management() {
    return SessionManagementContext.consume(this)!;
  }

  async setProjectSessionResolved(sessionId: string, resolved: boolean) {
    const projectPath = this.props.catalog.find(sessionId)?.projectPath;
    const viewedSessionId = this.props.shell.activeConversation?.sessionId;
    return this.management.resolveSession(sessionId, resolved, async (ids) => {
      if (!this.signal.aborted) await this.forgetProjectSessions(ids, projectPath, viewedSessionId);
    });
  }

  async setProjectSessionsResolved(
    sessionIds: readonly string[],
    resolved: boolean,
    origin: "user" | "agent" = "user",
  ) {
    const activeId = this.props.shell.activeConversation?.sessionId;
    const projectPath = activeId ? this.props.catalog.find(activeId)?.projectPath : undefined;
    return this.management.resolveSessionsById(
      sessionIds,
      resolved,
      origin === "user"
        ? async (ids) => {
            if (!this.signal.aborted) await this.forgetProjectSessions(ids, projectPath, activeId);
          }
        : undefined,
      origin,
    );
  }

  async deleteProjectSession(sessionId: string) {
    const session = this.props.catalog.find(sessionId);
    const wasSelected = this.props.shell.activeConversation?.sessionId === sessionId;
    const draft = this.props.registry.pendingSessions.isDraft(sessionId);
    // Deleting a Draft disposes its Stores: leave a viewed Draft for its Project Chat first, so
    // its mounted pane and observers stop reading them before deletion.
    if (draft && wasSelected && session?.projectPath)
      await this.props.openProjectChat(session.projectPath);
    if (!(await this.management.deleteSession(sessionId))) return;
    if (draft) {
      await this.forgetProjectSessions(
        [sessionId],
        session?.projectPath,
        wasSelected ? sessionId : undefined,
      );
      return;
    }
    if (!this.props.catalog.find(sessionId))
      await this.forgetSessions([sessionId], wasSelected ? session?.workingDirectory : undefined);
  }

  /** Drops sessions from navigation history and returns to the previous conversation. */
  async forgetSessions(sessionIds: readonly string[], fallbackProjectPath?: string) {
    if (this.signal.aborted) return;
    const activeSessionId = this.props.shell.activeConversation?.sessionId;
    const activeConversationRemoved =
      activeSessionId !== undefined && sessionIds.includes(activeSessionId);
    const target = this.props.shell.removeSessionsFromHistory(sessionIds);
    if (target) {
      await this.props.navigate(target);
      return;
    }
    if (activeConversationRemoved && fallbackProjectPath)
      await this.props.createProjectSession(fallbackProjectPath);
  }

  /** Live retirement drops selection/history, keeping landing observers alive for their receipts. */
  async returnToProjectChatAfterResolution(
    sessionIds: readonly string[],
    viewedSessionId: string,
    fallbackProjectPath?: string,
  ) {
    if (this.signal.aborted) return;
    const active = this.props.shell.activeConversation;
    if (
      active?.kind !== "project-session" ||
      active.sessionId !== viewedSessionId ||
      !sessionIds.includes(viewedSessionId)
    )
      return;
    const projectPath =
      this.props.catalog.find(viewedSessionId)?.projectPath ?? fallbackProjectPath;
    if (!projectPath) return;
    const opening = this.props.openProjectChat(projectPath);
    // Project Chat commits its selection before its async runtime/focus work. Retire
    // the old visits now, not after an await that could outlive a user's archive reopen.
    if (this.props.shell.activeConversation?.kind === "cake-chat") {
      this.props.shell.removeSessionsFromHistory(sessionIds);
      this.props.layout.removeSessions(sessionIds);
    }
    await opening;
  }

  /** Retires resolved sessions; only a removed selection returns to its local Project Chat. */
  async forgetProjectSessions(
    sessionIds: readonly string[],
    fallbackProjectPath?: string,
    viewedSessionId?: string,
  ) {
    if (this.signal.aborted) return;
    const active = this.props.shell.activeConversation;
    const activeSessionId =
      active?.kind === "project-session" && sessionIds.includes(active.sessionId)
        ? active.sessionId
        : undefined;
    // A background action must not retire a conversation the user opened while it ran.
    if (activeSessionId && activeSessionId !== viewedSessionId) return;
    const projectPath = activeSessionId
      ? (this.props.catalog.find(activeSessionId)?.projectPath ?? fallbackProjectPath)
      : undefined;
    // Prune retired visits, but never use history as the resolution destination.
    this.props.shell.removeSessionsFromHistory(sessionIds);
    this.props.layout.removeSessions(sessionIds);
    for (const sessionId of sessionIds) {
      this.props.registry.removeSession(sessionId);
    }
    if (projectPath) await this.props.openProjectChat(projectPath);
  }
}
