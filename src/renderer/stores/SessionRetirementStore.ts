import { Store } from "r-state-tree";
import type { AppShellStore, SessionHistoryEntry } from "./AppShellStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionLayoutStore } from "./SessionLayoutStore";
import type { SessionManagementStore } from "./SessionManagementStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";

export interface SessionRetirementStoreProps {
  shell: AppShellStore;
  catalog: SessionCatalogStore;
  registry: SessionRegistryStore;
  layout: SessionLayoutStore;
  projectSessions: SessionManagementStore;
  navigate(target: SessionHistoryEntry): Promise<void>;
  createProjectSession(projectPath: string): Promise<void>;
}

/**
 * Owns renderer retirement after authoritative resolve/delete commands.
 * Main/Pi owns lifecycle state; this window-scoped Store owns history, layout, registry, and
 * fallback-navigation cleanup. Transition serialization remains in each focused management Store.
 */
export class SessionRetirementStore extends Store<SessionRetirementStoreProps> {
  async setProjectSessionResolved(sessionId: string, resolved: boolean) {
    const rendererDraft = this.props.registry.pendingSessions.isDraft(sessionId);
    return this.props.projectSessions.resolveSession(sessionId, resolved, async (ids) => {
      if (!this.signal.aborted && !rendererDraft) await this.forgetProjectSessions(ids);
    });
  }

  async setProjectSessionsResolved(sessionIds: readonly string[], resolved: boolean) {
    return this.props.projectSessions.resolveSessionsById(sessionIds, resolved, async (ids) => {
      if (!this.signal.aborted) await this.forgetProjectSessions(ids);
    });
  }

  async deleteProjectSession(sessionId: string) {
    const session = this.props.catalog.find(sessionId);
    const wasSelected = this.props.shell.activeConversation?.sessionId === sessionId;
    await this.props.projectSessions.deleteSession(sessionId);
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

  /** Releases live Project Session ownership before navigating away from archived transcripts. */
  async forgetProjectSessions(sessionIds: readonly string[], fallbackProjectPath?: string) {
    if (this.signal.aborted) return;
    const active = this.props.shell.activeConversation;
    const activeSessionId =
      active?.kind === "project-session" && sessionIds.includes(active.sessionId)
        ? active.sessionId
        : undefined;
    const activeProjectPath = activeSessionId
      ? this.props.catalog.find(activeSessionId)?.projectPath
      : undefined;
    this.props.layout.removeSessions(sessionIds);
    for (const sessionId of sessionIds) this.props.registry.removeSession(sessionId);
    await this.forgetSessions(sessionIds, fallbackProjectPath ?? activeProjectPath);
  }
}
