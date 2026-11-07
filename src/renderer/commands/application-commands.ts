import type { CakeHotkeyActionId } from "../../contracts/application/cake-settings-data";
import type { AppShellStore } from "../stores/AppShellStore";
import type { CakeChatCollectionStore } from "../stores/CakeChatCollectionStore";
import type { NavigationStore } from "../stores/NavigationStore";
import type { NewSessionStore } from "../stores/NewSessionStore";
import type { ProjectWorkbenchStore } from "../stores/ProjectWorkbenchStore";
import type { SessionMetadataStore } from "../stores/SessionMetadataStore";
import type { WorkspaceNavigatorStore } from "../stores/WorkspaceNavigatorStore";
import type { TerminalStore } from "../stores/TerminalStore";
import type { SessionAssistantStore } from "../stores/SessionAssistantStore";
import type { DictationStore } from "../stores/DictationStore";
import type { UiHintModeStore } from "../stores/UiHintModeStore";

// The App handles hovered-message opening because it requires a DOM target.
type ApplicationCommandId = Exclude<CakeHotkeyActionId, "open-hovered-message">;

interface ApplicationCommand {
  enabled?(): boolean;
  run(): void;
}

/** Stateless dispatch. Dependencies and availability are read at invocation time, not registration. */
export function createApplicationCommandRegistry(owners: {
  shell(): AppShellStore;
  metadata(): SessionMetadataStore;
  workbench(): ProjectWorkbenchStore;
  cakeChat(): CakeChatCollectionStore;
  navigation(): NavigationStore;
  newSession(): NewSessionStore;
  workspaceNavigator(): WorkspaceNavigatorStore;
  terminal(): TerminalStore;
  hints(): UiHintModeStore;
  assistant(): SessionAssistantStore;
  dictation(): DictationStore;
}) {
  const projectSelected = () => owners.shell().selection.kind === "project-session";
  const projectResolved = () => {
    const selection = owners.shell().selection;
    return (
      selection.kind === "project-session" && owners.metadata().isResolved(selection.sessionId)
    );
  };
  const editableProject = () => projectSelected() && !projectResolved();
  const editableWorkspace = () =>
    editableProject() ||
    (owners.shell().selection.kind === "cake-chat" &&
      owners
        .cakeChat()
        .summaries.some(
          (chat) => chat.sessionId === owners.cakeChat().sessionId && chat.projectPath,
        ));
  const activeChat = () => {
    const selection = owners.shell().selection;
    if (selection.kind === "cake-chat")
      return selection.sessionId
        ? owners.cakeChat().registry.find(selection.sessionId)?.conversationSessionStore.chatStore
        : undefined;
    return selection.kind === "project-session"
      ? owners.workbench().activeSession?.conversationSessionStore.chatStore
      : undefined;
  };
  const toggleEditor: ApplicationCommand = {
    enabled: editableWorkspace,
    run: () => {
      void owners.workbench().presentationStore.toggleIde();
    },
  };
  const commands = {
    "new-session": { run: () => owners.newSession().show() },
    "toggle-dictation-mute": {
      run: () => {
        const store = owners.dictation();
        store.setMuted(store.activeTargetId, !store.muted);
      },
    },
    "open-companion": {
      enabled: () => Boolean(owners.assistant().contextSessionId),
      run: () => owners.assistant().openQuickPrompt(),
    },
    "toggle-agent-editor": toggleEditor,
    "open-editor": toggleEditor,
    "open-changes": {
      enabled: editableWorkspace,
      run: () => {
        void owners.workbench().presentationStore.toggleWorkspaceChanges();
      },
    },
    "toggle-browser": {
      enabled: () => editableProject() || owners.shell().selection.kind === "cake-chat",
      run: () => {
        void owners.workbench().presentationStore.toggleBrowser();
      },
    },
    "toggle-terminal": {
      enabled: () => !projectResolved(),
      run: () => {
        void owners.terminal().toggle();
      },
    },
    "new-terminal-tab": {
      enabled: () => !projectResolved() && owners.terminal().open,
      run: () => {
        void owners.terminal().newTab();
      },
    },
    "toggle-sidebar": { run: () => owners.workspaceNavigator().togglePane() },
    "toggle-session-tree": {
      enabled: editableProject,
      run: () => owners.workbench().commandPaneStore.toggle("tree"),
    },
    "return-to-project-chat": {
      run: () => {
        void owners.navigation().goUpOneLevel();
      },
    },
    "history-back": { run: () => owners.navigation().navigateBack() },
    "history-forward": { run: () => owners.navigation().navigateForward() },
    "next-active-session": { run: () => owners.navigation().navigateActiveSession("next") },
    "previous-active-session": { run: () => owners.navigation().navigateActiveSession("previous") },
    "show-ui-hints": { run: () => owners.hints().toggle() },
    "toggle-work-logs": { run: () => activeChat()?.workLogPresentation.cycleExpansion() },
    "cycle-work-log-view": { run: () => activeChat()?.workLogPresentation.cycleViewMode() },
    "open-settings": {
      run: () => {
        if (owners.shell().surface === "settings") owners.navigation().returnToWorkbench();
        else owners.navigation().showSettings();
      },
    },
  } satisfies Readonly<Record<ApplicationCommandId, ApplicationCommand>>;
  return {
    commands,
    execute(action: ApplicationCommandId) {
      if (action !== "show-ui-hints") owners.hints().close();
      const command: ApplicationCommand = commands[action];
      if (!command.enabled || command.enabled()) command.run();
    },
  };
}
