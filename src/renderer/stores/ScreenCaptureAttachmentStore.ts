import {
  DEFAULT_CAPTURE_ANNOTATION_COLOR,
  type CaptureAnnotationColor,
} from "../../utils/capture-annotation-colors";
import { speechRecognitionSettings } from "../../utils/speech-input-settings";
import type { DictationStore } from "./DictationStore";
import { Store, snapshot } from "r-state-tree";
import {
  DEFAULT_CAPTURE_MAX_DIMENSION,
  DEFAULT_CAPTURE_SHORTCUT,
  type CaptureDestination,
  type CapturePreferences,
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
import { WorkspaceNavigatorContext } from "./context/WorkspaceNavigatorContext";

/** Owns native capture preferences and destination routing, not chat or transcript state.
 * Preferences persist in the window snapshot. Captures are single-flight; only destination
 * presentation facts cross into the native editor, and choices are revalidated on completion.
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
  dictation(): DictationStore;
  cakeChat(): CakeChatCollectionStore;
  cakeChatCatalog: CakeChatCatalog;
  navigation(): NavigationStore;
}> {
  @snapshot annotationColor: CaptureAnnotationColor = DEFAULT_CAPTURE_ANNOTATION_COLOR;
  @snapshot shortcut = DEFAULT_CAPTURE_SHORTCUT;
  @snapshot maxDimension = DEFAULT_CAPTURE_MAX_DIMENSION;
  busy = false;
  /** The drop-down Cake Chat attaches captures only to the Cake Chat it shows. */
  cakeChatOnly = false;
  private recordingShortcut = false;
  error: string | undefined;
  private configurationQueue: Promise<void> = Promise.resolve();

  private isAvailable(target: WindowConversationSelection): target is CaptureDestination {
    if (target.kind === "automation-session") return false;
    if (target.kind === "cake-chat")
      return (
        this.props.cakeChat().summaries.find((session) => session.sessionId === target.sessionId)
          ?.resolved === false
      );
    const summary = this.props.catalog.find(target.sessionId);
    return summary
      ? !summary.resolved
      : this.props.registry.pendingSessions.isTemporary(target.sessionId);
  }

  get currentDestination() {
    const target = this.cakeChatOnly
      ? this.props.shell.activeConversation
      : this.props.shell.lastInteractedConversation;
    return target && this.isAvailable(target) ? target : undefined;
  }

  /** Shared destination presentation used by capture and quick Cake Chat. */
  get destinations(): Omit<CapturePreferences, "defaultDestination"> {
    const sidebar = this.props.sidebar();
    const settings = this.props.settings();
    const customTheme = settings.activeCustomTheme;
    return {
      annotationColor: this.annotationColor,
      appearance: {
        theme: customTheme?.type ?? settings.theme,
        importedTheme: customTheme,
        projectAvatarsEnabled: settings.projectAvatarsEnabled,
        sessionAvatarsEnabled: settings.sessionAvatarsEnabled,
        sidebarCharactersEnabled: settings.sidebarCharactersEnabled,
      },
      dictation: {
        enabled: this.props.dictation().enabled,
        deviceId: this.props.dictation().deviceId,
        textProcessingMode: this.props.dictation().textProcessingMode,
        recognition: speechRecognitionSettings(this.props.dictation().props.preferences.values),
      },
      projects: this.props.projects.orderedProjectPaths.map((path) => {
        // Preserve sidebar ordering, including collapsed descendants. Unsent pane
        // identities are valid destinations but intentionally not sidebar rows.
        const listed = sidebar.sessionListStore.projectSessions(path, false, true);
        const unsent = this.props.registry.targets
          .filter(
            (target) =>
              this.props.registry.pendingSessions.isTemporary(target.sessionId) &&
              !listed.some((session) => session.sessionId === target.sessionId) &&
              (this.props.catalog.projectPathFor(target.workspacePath) ?? target.workspacePath) ===
                path,
          )
          .map((target) => ({
            sessionId: target.sessionId,
            title: "New chat",
            modifiedAt: "",
            workingDirectory: target.workspacePath,
          }));
        const project: CapturePreferences["projects"][number] = {
          path,
          name: this.props.projects.nameForPath(path),
          sessions: [...listed, ...unsent].map((session) => {
            const worktree = sidebar.managedWorktree(session.workingDirectory);
            const activity = this.props.metadata().sessionActivity(session.sessionId);
            const worktreeName = "worktreeName" in session ? session.worktreeName : undefined;
            const option: CaptureSessionOption = {
              sessionId: session.sessionId,
              title: session.title || "New chat",
              modifiedAt: session.modifiedAt,
              activityTime: sidebar.sessionActivityTime(session.modifiedAt),
              labels: this.props.metadata().sessionLabels(session.sessionId),
              draft: "draft" in session && session.draft === true,
            };
            if (activity !== undefined) Object.assign(option, { activity });
            if (worktreeName !== undefined) Object.assign(option, { worktreeName });
            if ("familyParentSessionId" in session && session.familyParentSessionId !== undefined)
              Object.assign(option, { familyParentSessionId: session.familyParentSessionId });
            if ("familyChildSessionIds" in session && session.familyChildSessionIds !== undefined)
              Object.assign(option, { familyChildSessionIds: session.familyChildSessionIds });
            if ("familyDepth" in session && session.familyDepth !== undefined)
              Object.assign(option, { familyDepth: session.familyDepth });
            if (worktree)
              Object.assign(option, {
                managedWorktree: {
                  branch: worktree.branch,
                  baseBranch: worktree.baseBranch,
                  defaultBranch: worktree.defaultBranch,
                  parentWorktreePath: worktree.parentWorktreePath,
                  state: worktree.state,
                },
              });
            return option;
          }),
        };
        const chat = this.props.cakeChat().projectChat(path);
        if (chat && !chat.resolved) Object.assign(project, { chatSessionId: chat.sessionId });
        const icon = this.props.projects.find(path)?.settings?.icon;
        if (icon) Object.assign(project, { icon });
        return project;
      }),
      cakeChats: sidebar.sessionListStore.cakeChatSessions().map((session) => {
        const option: CaptureSessionOption = {
          sessionId: session.sessionId,
          title: session.title,
          modifiedAt: session.modifiedAt,
          activityTime: sidebar.sessionActivityTime(session.modifiedAt),
          labels: [],
        };
        if (this.props.cakeChat().registry.find(session.sessionId)?.streaming)
          Object.assign(option, { activity: "running" });
        else if (session.unread) Object.assign(option, { activity: "unread" });
        return option;
      }),
    };
  }

  private async prepareDestination(destination: CaptureDestination): Promise<CaptureDestination> {
    if (!this.isAvailable(destination))
      throw new Error("The destination chat is no longer editable.");
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
    const destinations = this.destinations;
    const choices = this.cakeChatOnly
      ? {
          ...destinations,
          projects: [],
          cakeChats: destinations.cakeChats.filter(
            (session) => session.sessionId === this.currentDestination?.sessionId,
          ),
        }
      : destinations;
    const remembered = this.currentDestination;
    const available =
      remembered &&
      (remembered.kind === "cake-chat"
        ? choices.cakeChats.some((session) => session.sessionId === remembered.sessionId)
        : choices.projects.some((project) =>
            project.sessions.some((session) => session.sessionId === remembered.sessionId),
          ));
    const recentSession = choices.projects.flatMap((project) => project.sessions)[0];
    const defaultDestination: CaptureDestination | undefined = available
      ? remembered
      : recentSession
        ? { kind: "project-session", sessionId: recentSession.sessionId }
        : choices.cakeChats[0]
          ? { kind: "cake-chat", sessionId: choices.cakeChats[0].sessionId }
          : undefined;
    this.busy = true;
    try {
      const preferences: CapturePreferences = { ...choices };
      if (defaultDestination) Object.assign(preferences, { defaultDestination });
      const completion = await this.props.client.startScreenCapture(preferences, {
        signal: this.signal,
      });
      if (this.signal.aborted) return;
      this.annotationColor = completion.annotationColor;
      const result = completion.capture;
      if (!result) return;
      const target = await this.prepareDestination(result.destination);
      if (this.signal.aborted) return;
      const draft = this.findDraft(target);
      if (!draft) throw new Error("The destination chat is no longer editable.");
      if (draft.attachments.length >= 20)
        throw new Error("The destination draft already has 20 attachments.");
      // Names identify annotations within this draft; durable storage keeps its UUID keys.
      const occupiedNames = new Set(
        draft.attachments.flatMap((attachment) => ("name" in attachment ? [attachment.name] : [])),
      );
      let name: string;
      do {
        name = `${Math.floor(Math.random() * 36 ** 3)
          .toString(36)
          .padStart(3, "0")}.png`;
      } while (occupiedNames.has(name));
      draft.appendAttachments([
        {
          kind: "image",
          name,
          mimeType: "image/png",
          data: result.data,
        },
      ]);
      if (result.annotationText)
        draft.setText(
          [draft.text, `${name}\n${result.annotationText}`].filter(Boolean).join("\n\n"),
        );
      // Reveal only after a successful handoff, after destination hydration/selection.
      // The window-owned companion tab must not hide the destination composer.
      WorkspaceNavigatorContext.consume(this)!.showChat();
      draft.requestFocus();
    } catch (error) {
      if (!this.signal.aborted)
        this.reportError(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
    }
  }
}
