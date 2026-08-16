import { Store } from "r-state-tree";
import type { WindowViewState } from "../../ipc/session-contract";
import type { DesktopClient } from "../desktop-client";
import { describeError } from "../error-details";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";
import type { ProjectSessionStore } from "./ProjectSessionStore";
import type { ProjectWorkbenchStore } from "./ProjectWorkbenchStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SettingsStore } from "./SettingsStore";
import type { SidebarStore } from "./SidebarStore";

export interface WindowPersistenceCoordinatorProps {
  client: Pick<DesktopClient, "listSessions" | "loadApplicationState" | "loadWindowState" | "saveWindowState">;
  projects: ProjectCatalogStore;
  sessions: SessionCatalogStore;
  registry: SessionRegistryStore;
  sidebar(): SidebarStore;
  settings(): SettingsStore;
  workbench(): ProjectWorkbenchStore;
}

/** Hydrates and persists state that spans multiple renderer workflow owners. */
export class WindowPersistenceCoordinator extends Store<WindowPersistenceCoordinatorProps> {
  hydrated = false;
  error: string | undefined;
  errorDetails: string | undefined;
  private restoredDraft = "";
  private restoredThinkingExpanded = false;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private hydration: Promise<void> | undefined;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(props: WindowPersistenceCoordinator["props"]) {
    super(props);
    this.effect(() => {
      return () => {
        if (this.persistTimer) clearTimeout(this.persistTimer);
      };
    });
  }

  hydrate() {
    this.hydration ??= this.performHydration();
    return this.hydration;
  }

  schedule() {
    if (!this.hydrated) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      const state = this.viewState();
      this.saveQueue = this.saveQueue
        .then(async () => {
          if (!this.signal.aborted) await this.props.client.saveWindowState(state);
        })
        .catch((error) => {
          if (!this.signal.aborted) this.setError(error);
        });
    }, 180);
  }

  applySessionRestore(session: ProjectSessionStore, previousSessionId?: string, restartDraft?: string) {
    if (restartDraft !== undefined) session.chatStore.setDraft(restartDraft);
    else if (!previousSessionId && !session.chatStore.draft) session.chatStore.setDraft(this.restoredDraft);
    session.chatStore.setThinkingExpanded(this.restoredThinkingExpanded);
    this.restoredDraft = "";
    this.restoredThinkingExpanded = false;
  }

  private async performHydration() {
    try {
      const [state, application, sessionIndex] = await Promise.all([
        this.props.client.loadWindowState(),
        this.props.client.loadApplicationState(),
        this.props.client.listSessions()
      ]);
      if (this.signal.aborted) return;
      this.props.sessions.replace(sessionIndex.sessions);
      this.props.projects.applyApplicationState(application);
      this.props.projects.restoreRecentPaths(state.recentProjectPaths);
      this.props.settings().theme = state.theme;
      this.restoredDraft = state.draft;
      this.restoredThinkingExpanded = state.thinkingExpanded;

      const reviewsBySession = new Map<string, typeof sessionIndex.reviewThreads>();
      for (const thread of sessionIndex.reviewThreads) {
        const key = this.sessionKey(thread.workspacePath, thread.sessionId);
        const threads = reviewsBySession.get(key) ?? [];
        threads.push(thread);
        reviewsBySession.set(key, threads);
      }
      for (const session of sessionIndex.sessions) {
        this.props.registry.applyReviewThreads(session.workspacePath, session.id, reviewsBySession.get(this.sessionKey(session.workspacePath, session.id)) ?? []);
      }
      for (const [sessionId, draft] of Object.entries(state.draftsBySession)) {
        const summary = sessionIndex.sessions.find((session) => session.id === sessionId);
        if (summary) this.props.registry.ensure(sessionId, summary.workspacePath).chatStore.setDraft(draft);
      }

      this.hydrated = true;
      await this.props.workbench().restoreSelection(state, sessionIndex.sessions);
    } catch (error) {
      if (this.signal.aborted) return;
      this.hydrated = true;
      this.setError(error);
    }
  }

  private viewState(): WindowViewState {
    const workbench = this.props.workbench();
    const activeSession = workbench.activeSession;
    return {
      projectPath: workbench.projectPath,
      selectedSessionId: activeSession?.sessionId,
      recentProjectPaths: this.props.projects.recentProjectPaths.slice(),
      draft: activeSession?.chatStore.draft ?? "",
      theme: this.props.settings().theme,
      thinkingExpanded: activeSession?.chatStore.thinkingExpanded ?? false,
      draftsBySession: Object.fromEntries(this.props.registry.sessions.map((session) => [session.sessionId, session.chatStore.draft]))
    };
  }

  private setError(error: unknown) {
    const described = describeError(error, "Window persistence");
    this.error = described.message;
    this.errorDetails = described.details;
  }

  private sessionKey(workspacePath: string, sessionId: string) {
    return `${workspacePath}\u0000${sessionId}`;
  }
}
