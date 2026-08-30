import { Store } from "r-state-tree";
import type { WindowViewState } from "../../ipc/session-contract";
import type { DesktopClient } from "../desktop-client";
import { describeError } from "../error-details";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";
import type { AppShellStore } from "./AppShellStore";
import type { GlobalChatStore } from "./GlobalChatStore";
import type { ProjectSessionStore } from "./ProjectSessionStore";
import type { ProjectWorkbenchStore } from "./ProjectWorkbenchStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SettingsStore } from "./SettingsStore";
import type { SidebarStore } from "./SidebarStore";

export interface WindowPersistenceCoordinatorStoreProps {
  client: Pick<
    DesktopClient,
    "listSessions" | "loadApplicationState" | "loadWindowState" | "saveWindowState"
  >;
  projects: ProjectCatalogStore;
  sessions: SessionCatalogStore;
  registry: SessionRegistryStore;
  sidebar(): SidebarStore;
  settings(): SettingsStore;
  workbench(): ProjectWorkbenchStore;
  shell(): AppShellStore;
  globalChat(): GlobalChatStore;
}

/** Hydrates and persists state that spans multiple renderer workflow owners. */
export class WindowPersistenceCoordinatorStore extends Store<WindowPersistenceCoordinatorStoreProps> {
  hydrated = false;
  error: string | undefined;
  errorDetails: string | undefined;
  private restoredDraft = "";
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private hydration: Promise<void> | undefined;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(props: WindowPersistenceCoordinatorStore["props"]) {
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
      void this.enqueueSave();
    }, 180);
  }

  /** Immediately commits the latest view state before a UI action can claim durable success. */
  flush() {
    if (!this.hydrated) return this.hydration ?? Promise.resolve();
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    return this.enqueueSave();
  }

  applySessionRestore(
    session: ProjectSessionStore,
    previousSessionId?: string,
    restartDraft?: string,
  ) {
    if (restartDraft !== undefined) session.chatStore.setDraft(restartDraft);
    else if (!previousSessionId && !session.chatStore.draft)
      session.chatStore.setDraft(this.restoredDraft);
    this.restoredDraft = "";
  }

  private async performHydration() {
    try {
      const [state, application, sessionIndex] = await Promise.all([
        this.props.client.loadWindowState(),
        this.props.client.loadApplicationState(),
        this.props.client.listSessions(),
      ]);
      if (this.signal.aborted) return;
      this.props.sessions.replace(sessionIndex.sessions);
      this.props.projects.applyApplicationState(application);
      for (const pending of state.pendingProjectSessions)
        this.props.registry.restorePendingNewSession(pending);
      this.props.globalChat().applyApplicationState(application);
      this.props.settings().applyApplicationState(application);
      this.props.projects.restoreRecentPaths(state.recentProjectPaths);
      this.props.settings().appearance.restore({
        theme: state.theme,
        workLogViewMode: state.workLogViewMode ?? "auto",
        workLogsExpansion: state.workLogsExpansion ?? "collapsed",
      });
      this.props.settings().modelPresets.restoreLastUsed(state.lastChatConfiguration);
      this.restoredDraft = state.draft;
      if (state.pendingCakeChat)
        this.props.globalChat().restorePendingSession(state.pendingCakeChat);

      const reviewsBySession = new Map<string, typeof sessionIndex.reviewThreads>();
      for (const thread of sessionIndex.reviewThreads) {
        const threads = reviewsBySession.get(thread.sessionId) ?? [];
        threads.push(thread);
        reviewsBySession.set(thread.sessionId, threads);
      }
      for (const session of sessionIndex.sessions) {
        this.props.registry.applyReviewThreads(session.id, reviewsBySession.get(session.id) ?? []);
      }
      for (const [sessionId, draft] of Object.entries(state.draftsBySession)) {
        const summary = sessionIndex.sessions.find((session) => session.id === sessionId);
        if (summary) this.props.registry.ensure(sessionId).chatStore.setDraft(draft);
      }

      const activeConversation = state.activeConversation;
      if (activeConversation) this.props.shell().restoreConversation(activeConversation);
      const projectState =
        activeConversation?.kind === "project-session"
          ? {
              ...state,
              projectPath: activeConversation.workspacePath,
              selectedSessionId: activeConversation.sessionId,
            }
          : state;

      this.hydrated = true;
      const projectRestore = this.props
        .workbench()
        .restoreSelection(projectState, this.props.sessions.sessions);
      if (activeConversation?.kind === "cake-chat") {
        await Promise.all([
          projectRestore,
          this.props.globalChat().openSession(activeConversation.sessionId),
        ]);
      } else {
        await projectRestore;
      }
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
      activeConversation: this.props.shell().activeConversation,
      recentProjectPaths: this.props.projects.orderedProjectPaths.slice(),
      draft: activeSession?.chatStore.draft ?? "",
      theme: this.props.settings().appearance.theme,
      workLogViewMode: this.props.settings().appearance.workLogViewMode,
      workLogsExpansion: this.props.settings().appearance.workLogsExpansion,
      draftsBySession: Object.fromEntries(
        this.props.registry.sessions.map((session) => [session.sessionId, session.chatStore.draft]),
      ),
      pendingProjectSessions: this.props.registry.pendingNewSessions(),
      pendingCakeChat: this.props.globalChat().pendingSessionState(),
      lastChatConfiguration: this.props.settings().modelPresets.lastUsedConfiguration,
    };
  }

  private enqueueSave() {
    const state = this.viewState();
    this.saveQueue = this.saveQueue
      .then(async () => {
        if (!this.signal.aborted) await this.props.client.saveWindowState(state);
      })
      .catch((error) => {
        if (!this.signal.aborted) this.setError(error);
      });
    return this.saveQueue;
  }

  private setError(error: unknown) {
    const described = describeError(error, "Window persistence");
    this.error = described.message;
    this.errorDetails = described.details;
  }
}
