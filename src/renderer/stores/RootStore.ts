import { Store, child, createStore, untracked } from "r-state-tree";
import type { CakeChatControlRequest } from "../../domain/cake-chat-data";
import type { ProjectSessionControlRequest } from "../../domain/project-session-data";
import type { JsonValue } from "../../ipc/json-contract";
import type { ChatConfiguration } from "../../ipc/session-contract";
import type { Client } from "../client/Client";
import { ClientContext } from "./context/ClientContext";
import { ActiveProjectSessionContext } from "./context/ActiveProjectSessionContext";
import { SettingsSessionContext } from "./context/SettingsSessionContext";
import type { SessionHistoryEntry } from "./AppShellStore";
import { SessionRegistryStore } from "./SessionRegistryStore";
import { ProjectWorkbenchStore } from "./ProjectWorkbenchStore";
import { SidebarStore } from "./SidebarStore";
import { ReviewsStore } from "./ReviewsStore";
import { SettingsStore } from "./SettingsStore";
import { ExtensionUiStore } from "./ExtensionUiStore";
import { FullscreenSurfaceStore } from "./FullscreenSurfaceStore";
import { AppControlBridge, type AgentControlSource } from "../app-control/AppControlBridge";
import { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import { AppShellStore } from "./AppShellStore";
import { InlineWidgetStore } from "./InlineWidgetStore";
import { SessionCatalogStore } from "./SessionCatalogStore";
import { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { AppControlOperationStore } from "./AppControlOperationStore";
import { ProjectCatalogStore } from "./ProjectCatalogStore";
import { ProjectSettingsStore } from "./ProjectSettingsStore";
import { NotificationStore } from "./NotificationStore";
import { KanbanStore } from "./KanbanStore";
import { ToastStore } from "./ToastStore";
import { TerminalStore, type TerminalTarget } from "./TerminalStore";
import { SessionLayoutStore, type SessionSplitAxis } from "./SessionLayoutStore";
import { SessionCoordinationStore } from "./SessionCoordinationStore";
import { resolveDraftUpdate } from "../../utils/resolve-draft-update";
import type { RootProjection } from "../models/RootProjection";
import { formatHotkey, type HotkeyActionId } from "../lib/hotkeys";

export class RootStore extends Store<{
  client: Client;
  projection: RootProjection;
  flushWindowState(): Promise<void>;
}> {
  readonly appControl: AppControlBridge;

  get projectCatalogModel() {
    return this.props.projection.projects;
  }
  get sessionCatalogModel() {
    return this.props.projection.sessionCatalog;
  }
  get cakeChatCatalogModel() {
    return this.props.projection.cakeChatCatalog;
  }

  [ClientContext.provide]() {
    return this.client;
  }

  [ActiveProjectSessionContext.provide]() {
    const context = this.projectWorkbenchStore.sessionContext();
    return context
      ? { sessionId: context.sessionId, workingDirectory: context.workspacePath }
      : undefined;
  }

  [SettingsSessionContext.provide]() {
    const active = this.appShellStore.activeConversation;
    if (active?.kind === "project-session") {
      const context = this.projectWorkbenchStore.sessionContext();
      return context?.sessionId === active.sessionId
        ? {
            kind: "project-session" as const,
            sessionId: context.sessionId,
            workingDirectory: context.workspacePath,
          }
        : undefined;
    }
    if (active?.kind === "cake-chat") {
      const session = this.cakeChatCollectionStore.findSession(active.sessionId);
      return session
        ? { kind: "cake-chat" as const, ...this.cakeChatCollectionStore.target(active.sessionId) }
        : undefined;
    }
    return undefined;
  }
  private readonly respondedCakeChatControlIds = new Set<string>();
  private readonly respondedProjectSessionControlIds = new Set<string>();

  @child
  get inlineWidgetStore(): InlineWidgetStore {
    return createStore(InlineWidgetStore);
  }

  @child
  get fullscreenSurfaceStore(): FullscreenSurfaceStore {
    return createStore(FullscreenSurfaceStore, {
      setOpen: (surfaceId, open) => this.client.electron.setFullscreenSurfaceOpen(surfaceId, open),
    });
  }

  get client() {
    return this.props.client;
  }

  private projectSessionWorkingDirectory(sessionId: string) {
    return (
      this.sessionCatalogStore.find(sessionId)?.workingDirectory ??
      this.sessionRegistry.findSession(sessionId)?.workspacePath
    );
  }

  private requireProjectSessionWorkingDirectory(sessionId: string) {
    const workingDirectory = this.projectSessionWorkingDirectory(sessionId);
    if (!workingDirectory) throw new Error("Cake could not find that session");
    return workingDirectory;
  }

  private retainProjectSessionObservation(sessionId: string) {
    const summary = this.sessionCatalogStore.find(sessionId);
    if (summary) this.sessionRegistry.load(sessionId, summary.workingDirectory);
    else this.sessionRegistry.retainObservation(sessionId);
  }

  async openSession(sessionId: string, messageId?: string) {
    this.requireProjectSessionWorkingDirectory(sessionId);
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.sessionLayoutStore.focusSession(sessionId);
    await this.projectWorkbenchStore.openSession(sessionId);
    if (this.projectWorkbenchStore.activeSession?.sessionId !== sessionId) return false;
    if (!messageId) return true;
    const session = this.sessionRegistry.findSession(sessionId);
    if (!session) return false;
    const message = session.chatStore.parts.find(
      (part) =>
        part.id === messageId ||
        (part.kind === "text" && part.entryId !== undefined && part.entryId === messageId),
    );
    if (!message) return false;
    session.chatStore.transcriptInteraction.navigateToMessage(message.id);
    return true;
  }

  private selectProjectSessionForShell(sessionId: string) {
    if (this.sessionCatalogStore.find(sessionId)?.resolved)
      this.appShellStore.previewResolvedProjectSession(sessionId);
    else this.appShellStore.selectProjectSession(sessionId);
  }

  initialize() {
    const selection = this.appShellStore.selection;
    if (selection.kind === "project-session") {
      this.sessionLayoutStore.ensureSession(selection.sessionId);
      return this.projectWorkbenchStore.initialize({
        sessionId: selection.sessionId,
        workspacePath: this.requireProjectSessionWorkingDirectory(selection.sessionId),
      });
    }
    if (selection.kind === "workbench") return this.projectWorkbenchStore.initialize();
    return Promise.resolve();
  }

  /** Opens the project or Cake Chat session addressed by a Markdown session link. */
  async openSessionLink(sessionId: string) {
    if (this.sessionCatalogStore.find(sessionId) || this.sessionRegistry.findSession(sessionId)) {
      await this.openSession(sessionId);
      return;
    }
    if (this.cakeChatCollectionStore.summaries.some((session) => session.sessionId === sessionId)) {
      await this.openCakeChat(sessionId);
      return;
    }
    throw new Error("Cake could not find the linked session");
  }

  openExternalUrl(url: string) {
    return this.client.electron.openExternalUrl(url, { signal: this.signal });
  }

  async createSession(workspacePath: string) {
    this.showEmptyWorkbench();
    await this.projectWorkbenchStore.startNewSession(workspacePath);
    const sessionId = this.projectWorkbenchStore.activeSession?.sessionId;
    if (sessionId) this.selectProjectSessionForShell(sessionId);
  }

  async createDraftSession(input: {
    workspacePath: string;
    name: string;
    initialPrompt: string;
    model?: ChatConfiguration;
  }) {
    const sessionId = await this.projectWorkbenchStore.createDraftSession(
      input.workspacePath,
      input.name,
      input.initialPrompt,
      input.model,
    );
    return { workspacePath: input.workspacePath, sessionId };
  }

  private projectControlSource(sessionId: string): AgentControlSource {
    const summary = this.sessionCatalogStore.find(sessionId);
    const loaded = this.sessionRegistry.findSession(sessionId);
    return {
      kind: "project-session",
      sessionId,
      title: summary?.title ?? "Agent session",
      projectName: summary?.projectName ?? "Unknown project",
      workingDirectory:
        summary?.workingDirectory ?? loaded?.workspacePath ?? "Unknown working directory",
    };
  }

  private cakeChatControlSource(sessionId: string): AgentControlSource {
    return {
      kind: "cake-chat",
      sessionId,
      title:
        this.cakeChatCollectionStore.summaries.find((session) => session.sessionId === sessionId)
          ?.title ?? "Cake Chat",
    };
  }

  private async forkProjectSession(
    sourceSessionId: string,
    input: Extract<ProjectSessionControlRequest["invocation"], { _tag: "ForkSession" }>,
  ): Promise<JsonValue> {
    const sourceWorkingDirectory = this.requireProjectSessionWorkingDirectory(sourceSessionId);
    const destinationWorkingDirectory = input.destinationWorkingDirectory ?? sourceWorkingDirectory;
    const result = await this.client.projectSessions.handoff(
      {
        sessionId: sourceSessionId,
        workingDirectory: sourceWorkingDirectory,
        entryId: input.entryId,
        resolveSource: input.resolveSource,
        destinationWorkingDirectory,
        ...(input.prompt === undefined ? null : { prompt: input.prompt }),
      },
      { signal: this.signal },
    );
    if (input.title !== undefined)
      await this.client.projectSessions.rename(
        {
          sessionId: result.sessionId,
          workingDirectory: destinationWorkingDirectory,
          name: input.title,
        },
        { signal: this.signal },
      );
    if (input.placement === "none")
      return {
        ok: true,
        sessionId: result.sessionId,
        placement: input.placement,
        sourceResolved: input.resolveSource,
      };

    this.sessionRegistry.load(result.sessionId, destinationWorkingDirectory);
    await this.client.projectSessions.open(
      { sessionId: result.sessionId, workingDirectory: destinationWorkingDirectory },
      { signal: this.signal },
    );
    const paneId = this.sessionLayoutStore.showChildSession(
      sourceSessionId,
      result.sessionId,
      input.placement === "right" ? "x" : "y",
    );
    if (!paneId) throw new Error("Cake could not open the fork beside its source session.");
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.selectProjectSessionForShell(result.sessionId);
    this.projectWorkbenchStore.showLoadedSession(result.sessionId);
    return {
      ok: true,
      sessionId: result.sessionId,
      placement: input.placement,
      paneId,
      sourceResolved: input.resolveSource,
    };
  }

  private async projectChildSession(
    parentSessionId: string,
    input: Extract<ProjectSessionControlRequest["invocation"], { _tag: "ProjectChildSession" }>,
  ): Promise<JsonValue> {
    const workingDirectory = this.requireProjectSessionWorkingDirectory(parentSessionId);
    this.sessionRegistry.loadUnlistedFamilySession(
      input.childSessionId,
      workingDirectory,
      input.title,
      {
        familyId: input.familyId,
        parentSessionId,
        childOrder: input.familyChildOrder,
      },
    );
    try {
      await this.client.projectSessions.open(
        { sessionId: input.childSessionId, workingDirectory },
        { signal: this.signal },
      );
    } catch (error) {
      this.sessionRegistry.removeSession(input.childSessionId);
      throw error;
    }
    if (input.placement === "none")
      return { ok: true, childSessionId: input.childSessionId, placement: input.placement };
    const paneId = this.sessionLayoutStore.showChildSession(
      parentSessionId,
      input.childSessionId,
      input.placement === "right" ? "x" : "y",
    );
    if (!paneId) throw new Error("Cake could not open a child pane beside its parent.");
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.selectProjectSessionForShell(input.childSessionId);
    this.projectWorkbenchStore.showLoadedSession(input.childSessionId);
    return { ok: true, childSessionId: input.childSessionId, placement: input.placement, paneId };
  }

  async respondProjectSessionControl(request: ProjectSessionControlRequest) {
    if (this.respondedProjectSessionControlIds.has(request.controlRequestId)) return;
    this.respondedProjectSessionControlIds.add(request.controlRequestId);
    const invocation = request.invocation;
    if (invocation._tag === "ForkSession") {
      const result = await this.forkProjectSession(request.sessionId, invocation).catch(
        (error) => ({
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      await this.client.projectSessions.respondControl(
        request.sessionId,
        request.controlRequestId,
        result,
        { signal: this.signal },
      );
      return;
    }
    if (invocation._tag === "ProjectChildSession") {
      const result = await this.projectChildSession(request.sessionId, invocation).catch(
        (error) => ({
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      await this.client.projectSessions.respondControl(
        request.sessionId,
        request.controlRequestId,
        result,
        { signal: this.signal },
      );
      return;
    }
    const catalogSession = this.sessionCatalogStore.find(request.sessionId);
    const loadedSession = this.sessionRegistry.findSession(request.sessionId);
    const sourceWorkingDirectory = catalogSession?.workingDirectory ?? loadedSession?.workspacePath;
    const projectPath =
      catalogSession?.projectPath ??
      (sourceWorkingDirectory
        ? (this.sessionCatalogStore.projectOfManagedWorktree(sourceWorkingDirectory) ??
          sourceWorkingDirectory)
        : undefined);
    const appInvocation =
      invocation._tag === "InvokeAppControl"
        ? { name: invocation.command, arguments: invocation.input }
        : projectPath
          ? {
              name:
                invocation._tag === "CreateSession" ? "sessions.create" : "sessions.create-draft",
              arguments: {
                workspacePath: projectPath,
                name: invocation.name,
                initialPrompt: invocation.initialPrompt,
                ...(invocation.model ? { model: invocation.model } : null),
                ...(invocation._tag === "CreateSession" && invocation.worktreeName !== undefined
                  ? { worktreeName: invocation.worktreeName }
                  : null),
              },
            }
          : undefined;
    const result = appInvocation
      ? await this.appControl
          .invoke(appInvocation, this.projectControlSource(request.sessionId))
          .catch((error) => ({
            ok: false as const,
            name: appInvocation.name,
            error: error instanceof Error ? error.message : String(error),
          }))
      : {
          ok: false as const,
          name: invocation._tag === "CreateSession" ? "sessions.create" : "sessions.create-draft",
          error: "Cake could not find the calling Project Session.",
        };
    await this.client.projectSessions.respondControl(
      request.sessionId,
      request.controlRequestId,
      result,
      { signal: this.signal },
    );
  }

  async createPromptedSession(input: {
    workspacePath: string;
    name: string;
    initialPrompt: string;
    model?: ChatConfiguration;
    worktreeName?: string;
    markdown?: boolean;
  }) {
    const managedWorktree = input.worktreeName
      ? await this.projectWorkbenchStore.worktreeCreationStore.create(input.workspacePath, {
          name: input.worktreeName,
        })
      : undefined;
    const workspacePath = managedWorktree?.worktreePath ?? input.workspacePath;
    const sessionId = await this.projectWorkbenchStore.createSession(
      workspacePath,
      input.name,
      input.initialPrompt,
      input.model,
      input.markdown !== false,
    );
    return managedWorktree
      ? { workspacePath, sessionId, managedWorktree }
      : { workspacePath, sessionId };
  }

  async startOneOffChat() {
    this.showEmptyWorkbench();
    await this.projectWorkbenchStore.startOneOffChat();
  }

  async chooseProject() {
    this.showEmptyWorkbench();
    await this.projectWorkbenchStore.chooseProject();
  }

  navigateBack() {
    const sessionId =
      this.appShellStore.surface === "workbench" && this.sessionLayoutStore.goBack();
    if (sessionId) void this.openSession(sessionId);
    else void this.navigateToHistoryEntry(this.appShellStore.goBack());
  }
  navigateForward() {
    const sessionId =
      this.appShellStore.surface === "workbench" && this.sessionLayoutStore.goForward();
    if (sessionId) void this.openSession(sessionId);
    else void this.navigateToHistoryEntry(this.appShellStore.goForward());
  }

  focusSessionPane(paneId: string) {
    const sessionId = this.sessionLayoutStore.focusPane(paneId);
    if (!sessionId || this.projectWorkbenchStore.activeSessionId === sessionId) return;
    this.selectProjectSessionForShell(sessionId);
    this.projectWorkbenchStore.showLoadedSession(sessionId);
  }

  focusAdjacentSessionPane(direction: "left" | "right" | "above" | "below") {
    if (this.appShellStore.selection.kind === "cake-chat") {
      const layout = this.cakeChatCollectionStore.sessionLayoutStore;
      const sessionId = layout.focusedSessionId;
      const target = sessionId ? layout.neighbors(sessionId)[direction][0] : undefined;
      if (target) this.focusCakeChatPane(target.paneId);
      return;
    }
    const sessionId = this.sessionLayoutStore.focusedSessionId;
    const target = sessionId
      ? this.sessionLayoutStore.neighbors(sessionId)[direction][0]
      : undefined;
    if (target) this.focusSessionPane(target.paneId);
  }

  focusSessionPaneNumber(number: number) {
    if (this.appShellStore.selection.kind === "cake-chat") {
      const pane = this.cakeChatCollectionStore.sessionLayoutStore.panes[number - 1];
      if (pane) this.focusCakeChatPane(pane.paneId);
      return;
    }
    const pane = this.sessionLayoutStore.panes[number - 1];
    if (pane) this.focusSessionPane(pane.paneId);
  }

  handleHotkey(action: HotkeyActionId) {
    const selection = this.appShellStore.selection;
    const projectSelected = selection.kind === "project-session";
    const chat =
      selection.kind === "cake-chat"
        ? selection.sessionId
          ? this.cakeChatCollectionStore.findSession(selection.sessionId)?.chatStore
          : undefined
        : projectSelected
          ? this.projectWorkbenchStore.activeSession?.chatStore
          : undefined;
    switch (action) {
      case "toggle-agent-editor":
        if (projectSelected) void this.projectWorkbenchStore.toggleIde();
        break;
      case "open-editor":
        if (projectSelected) void this.projectWorkbenchStore.openIde();
        break;
      case "open-changes":
        if (projectSelected) void this.projectWorkbenchStore.openWorkspaceChanges();
        break;
      case "toggle-terminal":
        void this.terminalStore.toggle();
        break;
      case "new-terminal-tab":
        if (this.terminalStore.open) void this.terminalStore.newTab();
        break;
      case "toggle-sidebar":
        this.sidebarStore.toggle();
        break;
      case "toggle-session-tree":
        if (projectSelected) this.projectWorkbenchStore.commandPaneStore.toggle("tree");
        break;
      case "split-right":
      case "split-down": {
        const axis = action === "split-right" ? "x" : "y";
        if (selection.kind === "cake-chat") this.splitFocusedCakeChat(axis);
        else if (projectSelected) this.splitFocusedSession(axis);
        break;
      }
      case "focus-left":
        this.focusAdjacentSessionPane("left");
        break;
      case "focus-right":
        this.focusAdjacentSessionPane("right");
        break;
      case "focus-above":
        this.focusAdjacentSessionPane("above");
        break;
      case "focus-below":
        this.focusAdjacentSessionPane("below");
        break;
      case "focus-pane-1":
      case "focus-pane-2":
      case "focus-pane-3":
      case "focus-pane-4":
        this.focusSessionPaneNumber(Number(action.at(-1)));
        break;
      case "history-back":
        this.navigateBack();
        break;
      case "history-forward":
        this.navigateForward();
        break;
      case "toggle-work-logs":
        chat?.workLogPresentation.cycleExpansion();
        break;
      case "cycle-work-log-view":
        chat?.workLogPresentation.cycleViewMode();
        break;
      case "open-hovered-message":
        break;
      case "open-settings":
        this.showSettings();
        break;
    }
  }

  splitFocusedSession(axis: SessionSplitAxis) {
    const source = this.projectWorkbenchStore.activeSession;
    if (!source || !this.sessionLayoutStore.canSplit) return;
    const sessionId = crypto.randomUUID();
    const session = this.sessionRegistry.prepareStagedSession(source.workspacePath, sessionId);
    const paneId = this.sessionLayoutStore.splitFocused(sessionId, axis);
    if (!paneId) {
      this.sessionRegistry.removeSession(sessionId);
      return;
    }
    this.selectProjectSessionForShell(sessionId);
    this.projectWorkbenchStore.showLoadedSession(sessionId);
    void session.stagedCommandStore.load(source.workspacePath);
    return { paneId, sessionId };
  }

  focusCakeChatPane(paneId: string) {
    const sessionId = this.cakeChatCollectionStore.focusPane(paneId);
    if (sessionId) this.appShellStore.selectCakeChat(sessionId);
  }

  splitFocusedCakeChat(axis: SessionSplitAxis) {
    const result = this.cakeChatCollectionStore.splitFocused(axis);
    if (result) this.appShellStore.selectCakeChat(result.sessionId);
    return result;
  }

  closeCakeChatPane(paneId: string) {
    const result = this.cakeChatCollectionStore.closePane(paneId);
    if (result?.focusedSessionId) this.appShellStore.selectCakeChat(result.focusedSessionId);
  }

  closeSessionPane(paneId: string) {
    const result = this.sessionLayoutStore.closePane(paneId);
    if (!result) return;
    for (const sessionId of result.removedSessionIds) {
      if (this.sessionRegistry.isStagedSession(sessionId))
        this.sessionRegistry.removeSession(sessionId);
    }
    if (result.focusedSessionId) {
      this.selectProjectSessionForShell(result.focusedSessionId);
      this.projectWorkbenchStore.showLoadedSession(result.focusedSessionId);
    }
  }
  private async navigateToHistoryEntry(entry: SessionHistoryEntry | undefined) {
    if (!entry) return;
    if (entry.kind === "cake-chat") await this.openCakeChat(entry.sessionId);
    else await this.openSession(entry.sessionId);
  }
  showWorkbench() {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    const context = this.projectWorkbenchStore.sessionContext();
    if (context) this.appShellStore.selectProjectSession(context.sessionId);
    else this.appShellStore.showWorkbench();
    this.projectWorkbenchStore.restoreSessionPresentation();
  }
  returnToWorkbench() {
    const active = this.appShellStore.activeConversation;
    if (active?.kind === "cake-chat") {
      this.appShellStore.selectCakeChat(active.sessionId);
      return;
    }
    this.showWorkbench();
    this.projectWorkbenchStore.activeSession?.composerStore.draftStore.requestFocus();
  }
  dismissTopSecondarySurface() {
    if (this.projectWorkbenchStore.sessionContinuationStore.prompt) {
      this.projectWorkbenchStore.sessionContinuationStore.cancelPrompt();
      return;
    }
    if (this.projectWorkbenchStore.embeddedEditorStore.visible) {
      this.projectWorkbenchStore.backToAgent();
      return;
    }
    if (this.projectWorkbenchStore.commandPaneStore.pane)
      this.projectWorkbenchStore.commandPaneStore.close();
  }
  showCakeChat(sessionId = this.cakeChatCollectionStore.sessionId) {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.appShellStore.selectCakeChat(sessionId);
  }
  async openCakeChat(sessionId?: string) {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    if (sessionId && this.cakeChatCollectionStore.isSessionResolved(sessionId))
      this.appShellStore.previewResolvedCakeChat(sessionId);
    else this.appShellStore.selectCakeChat(sessionId);
    if (sessionId) await this.cakeChatCollectionStore.openSession(sessionId);
  }
  async startCakeChat(prompt?: string) {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.appShellStore.selectCakeChat();
    await this.cakeChatCollectionStore.startNewSession(prompt);
    this.appShellStore.selectCakeChat(this.cakeChatCollectionStore.sessionId);
  }
  showTranscriptSelectionContextMenu(input: { canChat: boolean; canAnnotate: boolean }) {
    return this.client.electron.showTranscriptSelectionContextMenu(input, { signal: this.signal });
  }

  showKanban(projectPath: string) {
    if (!this.projectCatalogStore.find(projectPath)) return;
    if (
      this.appShellStore.selection.kind === "kanban" &&
      this.appShellStore.selection.projectPath === projectPath
    ) {
      this.returnToWorkbench();
      return;
    }
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.appShellStore.showKanban(projectPath);
  }

  showSettings() {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.appShellStore.showSettings();
  }
  showModelPresetSettings() {
    this.settingsStore.selectPage("models");
    this.settingsStore.modelPresets.requestSection();
    this.showSettings();
  }

  async removeProject(path: string, deleteSessions: boolean) {
    const sessionIds = this.sessionCatalogStore
      .projectSessions(path)
      .map((session) => session.sessionId);
    const removed = await this.projectWorkbenchStore.removeProject(path, deleteSessions);
    if (!removed) return false;
    const target = this.appShellStore.removeSessionsFromHistory(sessionIds);
    if (deleteSessions) {
      for (const sessionId of sessionIds) {
        this.sessionRegistry.removeSession(sessionId);
      }
    }
    if (target) await this.navigateToHistoryEntry(target);
    else if (
      (this.appShellStore.selection.kind === "project-session" &&
        sessionIds.includes(this.appShellStore.selection.sessionId)) ||
      (this.appShellStore.selection.kind === "kanban" &&
        this.appShellStore.selection.projectPath === path)
    )
      this.showEmptyWorkbench();
    return true;
  }

  private showEmptyWorkbench() {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.appShellStore.showWorkbench();
  }

  private async resolveProjectSession(sessionId: string, resolved: boolean) {
    const rendererDraft = this.sessionRegistry.isDraftSession(sessionId);
    const changed = await this.projectWorkbenchStore.sessionManagementStore.resolveSession(
      sessionId,
      resolved,
    );
    if (resolved && changed && !rendererDraft)
      await this.forgetResolvedProjectSessions([sessionId]);
    return changed;
  }

  private async deleteProjectSession(sessionId: string) {
    const session = this.sessionCatalogStore.find(sessionId);
    const wasSelected = this.appShellStore.activeConversation?.sessionId === sessionId;
    await this.projectWorkbenchStore.sessionManagementStore.deleteSession(sessionId);
    if (!this.sessionCatalogStore.find(sessionId))
      await this.forgetResolvedSessions(
        [sessionId],
        wasSelected ? session?.workingDirectory : undefined,
      );
  }

  private async deleteCakeChatSession(sessionId: string) {
    const wasSelected = this.appShellStore.activeConversation?.sessionId === sessionId;
    await this.cakeChatCollectionStore.deleteSession(sessionId);
    if (this.cakeChatCollectionStore.summaries.some((session) => session.sessionId === sessionId))
      return;
    await this.forgetResolvedSessions([sessionId]);
    if (wasSelected && this.appShellStore.activeConversation?.sessionId === sessionId)
      this.showCakeChat();
  }

  private async resolveCakeChatSession(sessionId: string, resolved: boolean) {
    await this.cakeChatCollectionStore.resolveSession(sessionId, resolved);
    if (!resolved) return;
    if (this.cakeChatCollectionStore.isSessionResolved(sessionId)) {
      await this.forgetResolvedSessions([sessionId]);
      return;
    }
    if (
      this.appShellStore.activeConversation?.kind === "cake-chat" &&
      this.appShellStore.activeConversation.sessionId === sessionId
    ) {
      this.appShellStore.selectCakeChat(this.cakeChatCollectionStore.sessionId);
    }
  }

  /** Drops resolved sessions from navigation history and returns to the previous session. */
  private async forgetResolvedSessions(
    sessionIds: readonly string[],
    fallbackProjectPath?: string,
  ) {
    const activeSessionId = this.appShellStore.activeConversation?.sessionId;
    const activeConversationRemoved =
      activeSessionId !== undefined && sessionIds.includes(activeSessionId);
    const target = this.appShellStore.removeSessionsFromHistory(sessionIds);
    if (target) {
      await this.navigateToHistoryEntry(target);
      return;
    }
    if (activeConversationRemoved && fallbackProjectPath)
      await this.createSession(fallbackProjectPath);
  }

  /** Ends live renderer ownership before navigating away from archived Pi sessions. */
  private async forgetResolvedProjectSessions(
    sessionIds: readonly string[],
    fallbackProjectPath?: string,
  ) {
    const active = this.appShellStore.activeConversation;
    const activeSessionId =
      active?.kind === "project-session" && sessionIds.includes(active.sessionId)
        ? active.sessionId
        : undefined;
    const activeProjectPath = activeSessionId
      ? this.sessionCatalogStore.find(activeSessionId)?.projectPath
      : undefined;
    this.sessionLayoutStore.removeSessions(sessionIds);
    for (const sessionId of sessionIds) this.sessionRegistry.removeSession(sessionId);
    if (this.appShellStore.selection.kind === "kanban") {
      this.appShellStore.removeSessionsFromHistory(sessionIds);
      return;
    }
    await this.forgetResolvedSessions(sessionIds, fallbackProjectPath ?? activeProjectPath);
  }

  @child
  get sessionLayoutStore(): SessionLayoutStore {
    return createStore(SessionLayoutStore);
  }

  @child
  get sessionRegistry(): SessionRegistryStore {
    return createStore(SessionRegistryStore, {
      catalog: this.sessionCatalogStore,
      operations: this.sessionOperationCoordinator,
      reviews: () => this.reviewsStore,
      sessionModel: (sessionId, workingDirectory) =>
        this.props.projection.projectSession(sessionId, workingDirectory),
      canSubmit: (sessionId) => this.projectWorkbenchStore.canSubmitSession(sessionId),
      isActive: (sessionId) =>
        this.appShellStore.selection.kind === "project-session" &&
        this.appShellStore.selection.sessionId === sessionId,
      isVisible: (sessionId) => this.sessionLayoutStore.hasSession(sessionId),
      openCommandPane: (pane) => this.projectWorkbenchStore.commandPaneStore.open(pane),
      persistNow: () => this.props.flushWindowState(),
      projectName: (workspacePath) => this.projectCatalogStore.nameForPath(workspacePath),
      abort: (sessionId) => this.projectWorkbenchStore.abortSession(sessionId),
      renameSession: (sessionId, name) =>
        this.projectWorkbenchStore.sessionManagementStore.renameSession(sessionId, name),
      handoffSession: (entryId, prompt, resolveSource) =>
        this.projectWorkbenchStore.sessionContinuationStore.handoffAt(
          entryId,
          prompt,
          resolveSource,
        ),
      modelPresets: () => this.settingsStore.modelPresets.presets,
      openModelPresetSettings: () => this.showModelPresetSettings(),
      newSessionRequest: (sessionId) => this.projectWorkbenchStore.newSessionRequest(sessionId),
      prepareNewSession: (sessionId, firstUserMessage) =>
        this.projectWorkbenchStore.prepareNewSession(sessionId, firstUserMessage),
      configureDraftActivation: (sessionId, choice) =>
        this.projectWorkbenchStore.configureDraftActivation(sessionId, choice),
      sessionCreationChoice: (sessionId) =>
        this.projectWorkbenchStore.sessionCreationChoice(sessionId),
      draftActivationCandidates: (sessionId) =>
        this.projectWorkbenchStore.draftActivationCandidates(sessionId),
      onWorktreeLanded: (record) => {
        this.sessionCatalogStore.noteManagedWorktree(record);
        this.toastStore.show({
          tone: "info",
          title: "Worktree merged",
          message: "Your work was merged back into the project.",
        });
      },
      onWorktreeDiscarded: (record) => this.sessionCatalogStore.noteManagedWorktree(record),
      prepareWorkingDirectoryRetirement: (workingDirectory) =>
        this.terminalStore.prepareWorkingDirectoryRetirement([workingDirectory]),
      onResolveWorktree: (workspacePath, options) =>
        this.projectWorkbenchStore.resolveWorktreeWorkspace(workspacePath, options),
      settings: () => this.settingsStore.appearance,
    });
  }

  private activeTerminalTarget(): TerminalTarget | undefined {
    const selection = this.appShellStore.selection;
    if (selection.kind !== "project-session") return undefined;
    const summary = this.sessionCatalogStore.find(selection.sessionId);
    if (summary?.resolved) return undefined;
    const workingDirectory = this.projectSessionWorkingDirectory(selection.sessionId);
    if (!workingDirectory) return undefined;
    const projectName =
      summary?.projectName || this.projectCatalogStore.nameForPath(workingDirectory);
    const worktreeName =
      summary && "worktreeName" in summary
        ? summary.worktreeName
        : summary?.managedWorktree?.branch.replace(/^agent\//, "");
    return {
      workingDirectory,
      label: worktreeName ? `${projectName} · ${worktreeName}` : projectName,
    };
  }

  @child
  get terminalStore(): TerminalStore {
    return createStore(TerminalStore, {
      activeTarget: () => this.activeTerminalTarget(),
      toggleAcceleratorHint: () =>
        formatHotkey(this.settingsStore.hotkeys.bindingFor("toggle-terminal")),
      newTabHotkey: () => this.settingsStore.hotkeys.bindingFor("new-terminal-tab"),
    });
  }

  @child
  get toastStore(): ToastStore {
    return createStore(ToastStore, {});
  }

  @child
  get notificationStore(): NotificationStore {
    return createStore(NotificationStore, {
      onError: (error) =>
        this.toastStore.show({
          tone: "error",
          title: "Notification failed",
          message: error instanceof Error ? error.message : String(error),
        }),
    });
  }

  @child
  get sessionCatalogStore(): SessionCatalogStore {
    return createStore(SessionCatalogStore, {
      model: this.sessionCatalogModel,
      pendingSessions: () => this.sessionRegistry.pendingSummaries,
    });
  }

  @child
  get projectCatalogStore(): ProjectCatalogStore {
    return createStore(ProjectCatalogStore, {
      sessions: this.sessionCatalogStore,
      model: this.projectCatalogModel,
    });
  }

  @child
  get projectSettingsStore(): ProjectSettingsStore {
    return createStore(ProjectSettingsStore, { projects: this.projectCatalogStore });
  }

  @child
  get kanbanStore(): KanbanStore {
    return createStore(KanbanStore, {
      projects: this.projectCatalogStore,
      catalog: this.sessionCatalogStore,
      registry: this.sessionRegistry,
      selectedProjectPath: () =>
        this.appShellStore.selection.kind === "kanban"
          ? this.appShellStore.selection.projectPath
          : undefined,
      utilityModelConfigured: () => Boolean(this.settingsStore.utilityModel.model),
      openSession: (sessionId) => this.openSession(sessionId),
      forgetResolvedSession: (sessionId) => this.forgetResolvedProjectSessions([sessionId]),
      reportError: (error) => this.projectWorkbenchStore.setError(error, "Project Kanban"),
    });
  }

  get projectSessionCatalogQueries() {
    return this.sidebarStore.projectSessionCatalogQueries;
  }

  /** Project Session targets currently eligible for Model observation. */
  get projectSessionObservationTargets() {
    const blockedPath = this.projectWorkbenchStore.pendingAuthorizationPath;
    return this.sessionRegistry.observationSessions
      .filter((session) => session.workspacePath !== blockedPath)
      .map((session) => ({
        sessionId: session.sessionId,
        workingDirectory: session.workspacePath,
      }));
  }

  @child
  get sessionOperationCoordinator(): SessionOperationCoordinatorStore {
    return createStore(SessionOperationCoordinatorStore);
  }

  @child
  get appControlOperationStore(): AppControlOperationStore {
    return createStore(AppControlOperationStore, { operations: this.sessionOperationCoordinator });
  }

  @child
  get sessionCoordinationStore(): SessionCoordinationStore {
    return createStore(SessionCoordinationStore, {
      sessionById: (sessionId) => this.sessionRegistry.findSession(sessionId)?.model,
    });
  }

  @child
  get sidebarStore(): SidebarStore {
    return createStore(SidebarStore, {
      projects: this.projectCatalogStore,
      catalog: this.sessionCatalogStore,
      sessions: this.sessionRegistry,
      cakeChat: () => this.cakeChatCollectionStore,
      selectedConversation: () => {
        const selection = this.appShellStore.selection;
        if (selection.kind === "project-session") return selection;
        return selection.kind === "cake-chat" && selection.sessionId
          ? { kind: "cake-chat", sessionId: selection.sessionId }
          : undefined;
      },
      setSessionResolved: async (sessionId, resolved) => {
        await this.resolveProjectSession(sessionId, resolved);
      },
      setSessionWorkflowStatus: async (sessionId, statusId) => {
        await this.kanbanStore.moveSession(sessionId, statusId);
      },
      setCakeChatSessionResolved: (sessionId, resolved) =>
        this.resolveCakeChatSession(sessionId, resolved),
      deleteSession: (sessionId) => this.deleteProjectSession(sessionId),
      deleteCakeChatSession: (sessionId) => this.deleteCakeChatSession(sessionId),
      setSessionUnread: (sessionId, unread) =>
        this.projectWorkbenchStore.sessionManagementStore.setSessionUnread(sessionId, unread),
      embeddedEditorSettings: this.settingsStore.embeddedEditor,
    });
  }

  @child
  get reviewsStore(): ReviewsStore {
    return createStore(ReviewsStore, {
      sessionRegistry: this.sessionRegistry,
    });
  }

  @child
  get settingsStore(): SettingsStore {
    return createStore(SettingsStore, {
      operations: this.sessionOperationCoordinator,
      activeSession: () => {
        const active = this.appShellStore.activeConversation;
        if (active?.kind === "project-session") {
          const session = this.projectWorkbenchStore.activeSession;
          return session?.sessionId === active.sessionId ? session : undefined;
        }
        return active?.kind === "cake-chat"
          ? this.cakeChatCollectionStore.findSession(active.sessionId)
          : undefined;
      },
      workbenchError: () => this.projectWorkbenchStore.error,
    });
  }

  @child
  get extensionUiStore(): ExtensionUiStore {
    return createStore(ExtensionUiStore, {
      activeSessionModel: () => this.projectWorkbenchStore.activeSession?.model,
      sessionContext: () => this.projectWorkbenchStore.sessionContext(),
      setDraft: (value) => {
        const session = this.projectWorkbenchStore.activeSession;
        if (session)
          session.composerStore.draftStore.setText(
            resolveDraftUpdate(value, session.composerStore.draftStore.text),
          );
      },
      requestComposerFocus: () =>
        this.projectWorkbenchStore.activeSession?.composerStore.draftStore.requestFocus(),
    });
  }

  @child
  get projectWorkbenchStore(): ProjectWorkbenchStore {
    return createStore(ProjectWorkbenchStore, {
      prepareWorkingDirectoryRetirement: (workingDirectories) =>
        this.terminalStore.prepareWorkingDirectoryRetirement(workingDirectories),
      sessionRegistry: this.sessionRegistry,
      operations: this.sessionOperationCoordinator,
      projects: this.projectCatalogStore,
      defaultConfiguration: () => this.settingsStore.modelPresets.defaultConfiguration,
      reviews: () => this.reviewsStore,
      extensionUi: () => this.extensionUiStore,
      catalog: this.sessionCatalogStore,
      startCakeChat: (prompt) => this.startCakeChat(prompt),
      onWorktreeSessionsResolved: (sessionIds, projectPath) =>
        this.forgetResolvedProjectSessions(sessionIds, projectPath),
      openSessionById: async (sessionId) => {
        await this.openSession(sessionId);
      },
      activeSessionId: () => {
        const active = this.appShellStore.activeConversation;
        return active?.kind === "project-session" ? active.sessionId : undefined;
      },
      restoreStagedSession: (projectPath) => {
        const sessionId = this.sessionLayoutStore.focusedSessionHistory.findLast((candidateId) => {
          if (!this.sessionRegistry.isStagedSession(candidateId)) return false;
          const session = this.sessionRegistry.findSession(candidateId);
          if (!session) return false;
          const candidateProjectPath =
            this.sessionCatalogStore.projectOfManagedWorktree(session.workspacePath) ??
            session.workspacePath;
          return candidateProjectPath === projectPath;
        });
        if (!sessionId) return undefined;
        return this.sessionLayoutStore.restoreFocusedHistorySession(sessionId)
          ? sessionId
          : undefined;
      },
      selectSession: (sessionId) => {
        this.sessionLayoutStore.showSession(sessionId);
        this.selectProjectSessionForShell(sessionId);
      },
      toggleProjectSidebar: () => this.sidebarStore.toggle(),
      enterIdeSidebarMode: () => this.sidebarStore.enterIdeMode(),
      leaveIdeSidebarMode: () => this.sidebarStore.leaveIdeMode(),
      projectSidebarWidth: () => this.sidebarStore.width,
      paneNumber: (sessionId) => this.sessionLayoutStore.paneNumber(sessionId),
    });
  }

  @child
  get cakeChatCollectionStore(): CakeChatCollectionStore {
    return createStore(CakeChatCollectionStore, {
      catalog: this.cakeChatCatalogModel,
      sessionModel: (sessionId) => this.props.projection.cakeChat(sessionId),
      tools: () => this.appControl.listTools(),
      modelPresets: () => this.settingsStore.modelPresets.presets,
      defaultConfiguration: () => this.settingsStore.modelPresets.defaultConfiguration,
      openModelPresetSettings: () => this.showModelPresetSettings(),
      settings: () => this.settingsStore.appearance,
    });
  }

  @child
  get appShellStore(): AppShellStore {
    return createStore(AppShellStore, {
      projectSessionResolved: (sessionId) => this.sessionCatalogModel.find(sessionId)?.resolved,
      cakeChatSessionResolved: (sessionId) => this.cakeChatCatalogModel.find(sessionId)?.resolved,
      onProjectSessionDeparted: (sessionId) =>
        this.sessionRegistry.findSession(sessionId)?.depart(),
    });
  }

  constructor(props: RootStore["props"]) {
    super(props);
    this.effect(() => {
      for (const session of this.cakeChatCollectionStore.loadedSessions)
        for (const request of session.model.controlRequests)
          if (!this.respondedCakeChatControlIds.has(request.controlRequestId)) {
            this.respondedCakeChatControlIds.add(request.controlRequestId);
            void this.respondCakeChatControl(request);
          }
    });
    this.appControl = new AppControlBridge({
      sessionCoordination: this.sessionCoordinationStore,
      currentSelection: () => {
        const selection = this.appShellStore.selection;
        if (selection.kind === "project-session") {
          if (
            this.sessionRegistry.isTemporarySession(selection.sessionId) &&
            !this.sessionRegistry.isDraftSession(selection.sessionId)
          )
            return { kind: "new-project-chat" as const };
          const summary = this.sessionCatalogStore.find(selection.sessionId);
          const workspacePath = this.projectSessionWorkingDirectory(selection.sessionId) ?? "";
          return {
            kind: "project-session" as const,
            sessionId: selection.sessionId,
            title: summary?.title ?? "New chat",
            workspacePath,
            workspaceName:
              summary?.projectName ?? this.projectCatalogStore.nameForPath(workspacePath),
          };
        }
        if (selection.kind === "cake-chat") {
          if (
            !selection.sessionId ||
            (this.cakeChatCollectionStore.isPendingSession(selection.sessionId) &&
              !this.cakeChatCollectionStore.isDraftSession(selection.sessionId))
          )
            return { kind: "new-cake-chat" as const };
          return {
            kind: "cake-chat" as const,
            sessionId: selection.sessionId,
            title:
              this.cakeChatCollectionStore.summaries.find(
                (session) => session.sessionId === selection.sessionId,
              )?.title ?? "Cake Chat",
          };
        }
        if (selection.kind === "settings")
          return { kind: "settings" as const, page: this.settingsStore.activePage };
        return { kind: "workbench" as const };
      },
      sessionLayout: (source) => {
        const layout =
          source?.kind === "cake-chat"
            ? this.cakeChatCollectionStore.sessionLayoutStore
            : this.sessionLayoutStore;
        const relativeSessionId =
          source?.sessionId && layout.hasSession(source.sessionId)
            ? source.sessionId
            : layout.focusedSessionId;
        return {
          focusedSessionId: layout.focusedSessionId,
          ...(relativeSessionId ? { originSessionId: relativeSessionId } : null),
          panes: layout.panePlacements.map((pane) => ({ ...pane })),
          ...(relativeSessionId ? { neighbors: layout.neighbors(relativeSessionId) } : null),
        };
      },
      projects: () => this.projectCatalogStore.projects,
      sessions: () => this.sessionCatalogStore.sessions,
      cakeChatSessions: () => this.cakeChatCollectionStore.summaries,
      sessionActivity: (sessionId) => this.sidebarStore.sessionActivity(sessionId),
      openSession: (sessionId, messageId) => this.openSession(sessionId, messageId),
      createSession: (input) => this.createPromptedSession(input),
      createDraftSession: (input) => this.createDraftSession(input),
      sendSessionMessage: (sessionId, text, delivery, crossSession) =>
        this.appControlOperationStore.run(() => {
          this.retainProjectSessionObservation(sessionId);
          const command =
            delivery === "steer"
              ? this.client.projectSessions.steer
              : delivery === "follow-up"
                ? this.client.projectSessions.followUp
                : this.client.projectSessions.prompt;
          return command(
            {
              sessionId,
              text,
              renderUserMessageAsMarkdown: false,
              attachments: [],
              ...(crossSession ? { crossSession } : null),
            },
            { signal: this.signal },
          );
        }),
      compactSession: (sessionId, instructions) =>
        this.appControlOperationStore.run(() =>
          this.client.projectSessions.compact({ sessionId, instructions }, { signal: this.signal }),
        ),
      scheduleSessionMessage: (input) =>
        this.appControlOperationStore.run(() =>
          this.client.scheduledMessages.schedule(input, { signal: this.signal }),
        ),
      listScheduledMessages: (sessionId) =>
        this.client.scheduledMessages.list(sessionId, { signal: this.signal }),
      cancelScheduledMessage: (id) =>
        this.appControlOperationStore.run(() =>
          this.client.scheduledMessages.cancel(id, { signal: this.signal }),
        ),
      listPendingMessages: (sessionId) =>
        this.client.projectSessions.listQueuedMessages({ sessionId }, { signal: this.signal }),
      dequeuePendingMessages: (sessionId) =>
        this.appControlOperationStore.run(() =>
          this.client.projectSessions.clearQueue({ sessionId }, { signal: this.signal }),
        ),
      abortSession: (sessionId) =>
        this.appControlOperationStore.run(() =>
          this.client.projectSessions.abort({ sessionId }, { signal: this.signal }),
        ),
      renameSession: (sessionId, title) =>
        this.cakeChatCollectionStore.summaries.some((session) => session.sessionId === sessionId)
          ? this.cakeChatCollectionStore.renameSession(sessionId, title).then(() => undefined)
          : this.projectWorkbenchStore.sessionManagementStore.renameSession(sessionId, title),
      setSessionResolved: async (sessionId, resolved) => {
        await this.resolveProjectSession(sessionId, resolved);
      },
      setSessionsResolved: async (sessionIds, resolved) => {
        const count = await this.projectWorkbenchStore.sessionManagementStore.resolveSessionsById(
          sessionIds,
          resolved,
        );
        if (resolved && count === sessionIds.length)
          await this.forgetResolvedProjectSessions(sessionIds);
        return count;
      },
      setCakeChatSessionsResolved: async (sessionIds, resolved) => {
        const count = await this.cakeChatCollectionStore.resolveSessions(sessionIds, resolved);
        if (resolved) await this.forgetResolvedSessions(sessionIds);
        return count;
      },
      setSessionModel: (sessionId, provider, modelId) =>
        this.appControlOperationStore.run(() =>
          this.client.projectSessions.setModel(
            { sessionId, provider, modelId },
            { signal: this.signal },
          ),
        ),
      splitView: (source, direction) => {
        const axis = direction === "right" ? "x" : "y";
        if (source.kind === "cake-chat") {
          const pane = this.cakeChatCollectionStore.sessionLayoutStore.paneForSession(
            source.sessionId,
          );
          if (!pane) return undefined;
          this.focusCakeChatPane(pane.paneId);
          const split = this.splitFocusedCakeChat(axis);
          return split ? { kind: source.kind, ...split } : undefined;
        }
        const pane = this.sessionLayoutStore.paneForSession(source.sessionId);
        if (!pane) return undefined;
        this.focusSessionPane(pane.paneId);
        const split = this.splitFocusedSession(axis);
        return split ? { kind: source.kind, ...split } : undefined;
      },
      showNotification: (input) => this.notificationStore.enqueue(input),
      showAgentAction: ({ source, message, targetSessionId, targetKind, coalesceKey }) => {
        const action =
          targetSessionId && targetKind
            ? {
                label: "View",
                run: async () => {
                  if (targetKind === "cake-chat") await this.openCakeChat(targetSessionId);
                  else await this.openSession(targetSessionId);
                },
              }
            : undefined;
        this.toastStore.show({
          title: `Agent action · ${source.title}`,
          message,
          action,
          coalesceKey: `agent:${source.sessionId}:${coalesceKey}`,
        });
      },
    });
    this.effect(() => {
      untracked(() => void this.cakeChatCollectionStore.initialize());
    });
  }

  private async respondCakeChatControl(request: CakeChatControlRequest) {
    const result = await this.appControl
      .invoke(request.invocation, this.cakeChatControlSource(request.sessionId))
      .catch((error) => ({
        ok: false as const,
        name: request.invocation.name,
        error: error instanceof Error ? error.message : String(error),
      }));
    try {
      await this.client.cakeChats.respondControl(request.controlRequestId, result, {
        signal: this.signal,
      });
    } catch (error) {
      if (!this.signal.aborted)
        this.cakeChatCollectionStore.reportError(
          error,
          `Cake Chat control response: ${request.invocation.name}`,
        );
    }
  }
}
