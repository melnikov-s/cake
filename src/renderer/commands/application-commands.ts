import type { CakeHotkeyActionId } from "../../ipc/cake-settings-data";
import type { AppShellStore } from "../stores/AppShellStore";
import type { CakeChatCollectionStore } from "../stores/CakeChatCollectionStore";
import type { NavigationStore } from "../stores/NavigationStore";
import type { NewSessionStore } from "../stores/NewSessionStore";
import type { ProjectWorkbenchStore } from "../stores/ProjectWorkbenchStore";
import type { SessionMetadataStore } from "../stores/SessionMetadataStore";
import type { SidebarStore } from "../stores/SidebarStore";
import type { TerminalStore } from "../stores/TerminalStore";
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
  sidebar(): SidebarStore;
  terminal(): TerminalStore;
  hints(): UiHintModeStore;
}) {
  const projectSelected = () => owners.shell().selection.kind === "project-session";
  const projectResolved = () => {
    const selection = owners.shell().selection;
    return (
      selection.kind === "project-session" && owners.metadata().isResolved(selection.sessionId)
    );
  };
  const editableProject = () => projectSelected() && !projectResolved();
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
    enabled: editableProject,
    run: () => {
      void owners.workbench().presentationStore.toggleIde();
    },
  };
  const commands = {
    "new-session": { run: () => owners.newSession().show() },
    "toggle-agent-editor": toggleEditor,
    "open-editor": toggleEditor,
    "open-changes": {
      enabled: editableProject,
      run: () => {
        void owners.workbench().presentationStore.toggleWorkspaceChanges();
      },
    },
    "toggle-browser": {
      enabled: editableProject,
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
    "toggle-sidebar": { run: () => owners.sidebar().toggle() },
    "toggle-session-tree": {
      enabled: editableProject,
      run: () => owners.workbench().commandPaneStore.toggle("tree"),
    },
    "split-right": {
      enabled: projectSelected,
      run: () => {
        owners.navigation().splitFocusedSession("x");
      },
    },
    "split-down": {
      enabled: projectSelected,
      run: () => {
        owners.navigation().splitFocusedSession("y");
      },
    },
    "focus-left": { run: () => owners.navigation().focusAdjacentSessionPane("left") },
    "focus-right": { run: () => owners.navigation().focusAdjacentSessionPane("right") },
    "focus-above": { run: () => owners.navigation().focusAdjacentSessionPane("above") },
    "focus-below": { run: () => owners.navigation().focusAdjacentSessionPane("below") },
    "focus-pane-1": { run: () => owners.navigation().focusSessionPaneNumber(1) },
    "focus-pane-2": { run: () => owners.navigation().focusSessionPaneNumber(2) },
    "focus-pane-3": { run: () => owners.navigation().focusSessionPaneNumber(3) },
    "focus-pane-4": { run: () => owners.navigation().focusSessionPaneNumber(4) },
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
