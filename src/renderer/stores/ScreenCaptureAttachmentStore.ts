import { Store, snapshot, untracked } from "r-state-tree";
import {
  DEFAULT_CAPTURE_MAX_DIMENSION,
  DEFAULT_CAPTURE_SHORTCUT,
  type CaptureDestination,
  type CaptureRouting,
  type CaptureSessionOption,
} from "../../contracts/desktop/screen-capture-data";
import type { Client } from "../client/Client";
import type { AppShellStore, WindowConversationSelection } from "./AppShellStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import type { CakeChatCatalog } from "../models/CakeChatCatalog";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import type { NavigationStore } from "./NavigationStore";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionMetadataStore } from "./SessionMetadataStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SidebarStore } from "./SidebarStore";
import { ToastContext } from "./context/ToastContext";

/** Owns native capture preferences and destination routing, not chat or transcript state.
 * Preferences/last destination persist in the window snapshot. Captures are single-flight;
 * overlay choices are frozen at activation and revalidated before appending. New destinations
 * create an empty session only after capture succeeds, never on cancellation.
 */
export class ScreenCaptureAttachmentStore extends Store<{
  client: Client["electron"];
  shell: AppShellStore;
  projects: ProjectCatalogStore;
  catalog: SessionCatalogStore;
  registry: SessionRegistryStore;
  sidebar(): SidebarStore;
  metadata(): SessionMetadataStore;
  settings(): AppearanceSettingsStore;
  cakeChat(): CakeChatCollectionStore;
  cakeChatCatalog: CakeChatCatalog;
  navigation(): NavigationStore;
}> {
  @snapshot shortcut = DEFAULT_CAPTURE_SHORTCUT;
  @snapshot maxDimension = DEFAULT_CAPTURE_MAX_DIMENSION;
  @snapshot private lastTarget: WindowConversationSelection | undefined;
  busy = false;
  private recordingShortcut = false;
  error: string | undefined;
  private configurationQueue: Promise<void> = Promise.resolve();

  constructor(props: ScreenCaptureAttachmentStore["props"]) {
    super(props);
    this.reaction(
      () => this.props.shell.activeConversation,
      (target, previous) => {
        const remembered = target ?? previous;
        if (remembered)
          untracked(() => {
            this.lastTarget = { ...remembered };
          });
      },
    );
  }

  private get destinations(): Omit<CaptureRouting, "defaultDestination"> {
    const sidebar = this.props.sidebar();
    const settings = this.props.settings();
    return {
      appearance: {
        theme: settings.theme,
        sessionAvatarsEnabled: settings.sessionAvatarsEnabled,
        sidebarCharactersEnabled: settings.sidebarCharactersEnabled,
      },
      projects: this.props.projects.orderedProjectPaths.map((path) => {
        // Preserve sidebar ordering, including collapsed descendants. Unsent pane
        // identities are valid destinations but intentionally not sidebar rows.
        const listed = sidebar.sessionListStore.projectSessions(path, false, true);
        const unsent = this.props.registry.unsentSessionsForProject(path, listed);
        return {
          path,
          name: this.props.projects.nameForPath(path),
          sessions: [...listed, ...unsent].map((session) => {
            const worktree = sidebar.managedWorktree(session.workingDirectory);
            const activity = sidebar.sessionListStore.sessionActivityForDisplay(session);
            const worktreeName = "worktreeName" in session ? session.worktreeName : undefined;
            const option: CaptureSessionOption = {
              sessionId: session.sessionId,
              title: session.title || "New chat",
              modifiedAt: session.modifiedAt,
              activityTime: sidebar.sessionActivityTime(session.modifiedAt),
              labels: this.props.metadata().sessionLabels(session.sessionId),
              draft: session.draft ?? false,
              familyCollapsed: sidebar.sessionListStore.isFamilyCollapsed(session.sessionId),
            };
            if (activity !== undefined) Object.assign(option, { activity });
            if (worktreeName !== undefined) Object.assign(option, { worktreeName });
            if (session.familyParentSessionId !== undefined)
              Object.assign(option, { familyParentSessionId: session.familyParentSessionId });
            if (session.familyChildSessionIds !== undefined)
              Object.assign(option, { familyChildSessionIds: session.familyChildSessionIds });
            if (session.familyDepth !== undefined)
              Object.assign(option, { familyDepth: session.familyDepth });
            if (worktree)
              Object.assign(option, {
                managedWorktree: {
                  branch: worktree.branch,
                  baseBranch: worktree.baseBranch,
                  parentWorktreePath: worktree.parentWorktreePath,
                  state: worktree.state,
                },
              });
            return option;
          }),
        };
      }),
      cakeChats: sidebar.sessionListStore.cakeChatSessions().map((session) => {
        const option: CaptureSessionOption = {
          sessionId: session.sessionId,
          title: session.title,
          modifiedAt: session.modifiedAt,
          activityTime: sidebar.sessionActivityTime(session.modifiedAt),
          labels: [],
          familyCollapsed: false,
        };
        if (this.props.cakeChat().registry.find(session.sessionId)?.streaming)
          Object.assign(option, { activity: "running" });
        else if (session.unread) Object.assign(option, { activity: "unread" });
        return option;
      }),
    };
  }

  private async prepareDestination(
    destination: CaptureDestination,
  ): Promise<WindowConversationSelection> {
    if (destination.kind === "new-session") {
      if (!this.props.projects.find(destination.projectPath))
        throw new Error("The destination Project is no longer available.");
      const sessionId = crypto.randomUUID();
      this.props.registry.pendingSessions.prepareStaged(destination.projectPath, sessionId);
      if (!(await this.props.navigation().openSession(sessionId)))
        throw new Error("Cake could not create the destination session.");
      return { kind: "project-session", sessionId };
    }
    if (destination.kind === "project-session") {
      if (this.props.catalog.find(destination.sessionId)?.resolved)
        throw new Error("The destination chat is no longer editable.");
      const loaded = this.props.registry.findSession(destination.sessionId);
      if (
        !loaded ||
        (!loaded.model.sessionFile &&
          !this.props.registry.pendingSessions.isTemporary(destination.sessionId))
      ) {
        if (!(await this.props.navigation().openSession(destination.sessionId)))
          throw new Error("Cake could not open the destination session.");
      } else {
        this.props.navigation().showLoadedProjectSession(destination.sessionId);
      }
    } else {
      if (this.props.cakeChatCatalog.find(destination.sessionId)?.resolved)
        throw new Error("The destination chat is no longer editable.");
      await this.props.navigation().openCakeChat(destination.sessionId);
    }
    return destination;
  }

  private findDraft(target: WindowConversationSelection) {
    if (target.kind === "project-session") {
      if (this.props.metadata().isResolved(target.sessionId)) return undefined;
      return this.props.registry.findSession(target.sessionId)?.conversationSessionStore
        .composerStore.draftStore;
    }
    if (this.props.cakeChatCatalog.find(target.sessionId)?.resolved) return undefined;
    return this.props.cakeChat().registry.find(target.sessionId)?.conversationSessionStore
      .composerStore.draftStore;
  }

  private get toast() {
    return ToastContext.consume(this)!;
  }

  private reportError(message: string) {
    this.toast.show({ tone: "error", title: "Screen capture", message });
  }

  configure() {
    const settings = {
      shortcut: this.recordingShortcut ? "" : this.shortcut,
      maxDimension: this.maxDimension,
    };
    this.configurationQueue = this.configurationQueue.then(async () => {
      if (this.signal.aborted) return;
      try {
        await this.props.client.configureScreenCapture(settings, { signal: this.signal });
        if (!this.signal.aborted) this.error = undefined;
      } catch (error) {
        if (!this.signal.aborted) {
          this.error = error instanceof Error ? error.message : String(error);
          this.reportError(this.error);
        }
      }
    });
    return this.configurationQueue;
  }

  setRecordingShortcut(recording: boolean) {
    if (this.recordingShortcut === recording) return;
    this.recordingShortcut = recording;
    void this.configure();
  }

  setShortcut(value: string) {
    this.shortcut = value;
    void this.configure();
  }
  setMaxDimension(value: number) {
    if (!Number.isInteger(value) || value < 256 || value > 8192) return;
    this.maxDimension = value;
    void this.configure();
  }

  async capture() {
    if (this.busy || this.recordingShortcut) return;
    const choices = this.destinations;
    const remembered = this.props.shell.activeConversation ?? this.lastTarget;
    const available =
      remembered &&
      (remembered.kind === "cake-chat"
        ? choices.cakeChats.some((session) => session.sessionId === remembered.sessionId)
        : choices.projects.some((project) =>
            project.sessions.some((session) => session.sessionId === remembered.sessionId),
          ));
    const project = choices.projects[0];
    const recentSession = project?.sessions[0];
    const defaultDestination: CaptureDestination | undefined = available
      ? remembered
      : recentSession
        ? { kind: "project-session", sessionId: recentSession.sessionId }
        : project
          ? { kind: "new-session", projectPath: project.path }
          : choices.cakeChats[0]
            ? { kind: "cake-chat", sessionId: choices.cakeChats[0].sessionId }
            : undefined;
    if (!defaultDestination) {
      this.reportError("Add a Project before capturing an attachment.");
      return;
    }
    this.busy = true;
    try {
      const result = await this.props.client.startScreenCapture(
        { ...choices, defaultDestination },
        { signal: this.signal },
      );
      if (this.signal.aborted || !result) return;
      const target = await this.prepareDestination(result.destination);
      if (this.signal.aborted) return;
      const draft = this.findDraft(target);
      if (!draft) throw new Error("The destination chat is no longer editable.");
      if (draft.attachments.length >= 20)
        throw new Error("The destination draft already has 20 attachments.");
      draft.appendAttachments([
        {
          kind: "image",
          name: `Screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
          mimeType: "image/png",
          data: result.data,
        },
      ]);
      this.lastTarget = { ...target };
      draft.requestFocus();
    } catch (error) {
      if (!this.signal.aborted)
        this.reportError(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
    }
  }
}
