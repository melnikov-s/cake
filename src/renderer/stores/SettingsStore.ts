import type { DictationStore } from "./DictationStore";
import type { ScreenCaptureAttachmentStore } from "./ScreenCaptureAttachmentStore";
import type { SpeechSettingsStore } from "./SpeechSettingsStore";
import type { SpeechInputSettingsStore } from "./SpeechInputSettingsStore";
import type { DesktopConnectionStore } from "./DesktopConnectionStore";
import { Store, child, createStore, untracked } from "r-state-tree";
import type {
  CakeSettingsSectionId,
  CakeSettingsSectionView,
  CakeSettingsUpdate,
} from "../../contracts/application/cake-settings-data";
import type { ApplicationState } from "../../contracts/conversations/session-contract";
import { hotkeyDefinitions } from "../lib/hotkeys";
import { DesktopSharingSettingsStore } from "./DesktopSharingSettingsStore";
import { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { AgentNavigationSettingsStore } from "./AgentNavigationSettingsStore";
import { ModelPresetSettingsStore } from "./ModelPresetSettingsStore";
import { ProviderSettingsStore } from "./ProviderSettingsStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { ProjectSessionStore } from "./ProjectSessionStore";
import { McpSettingsStore } from "./McpSettingsStore";
import { LocalMcpSettingsStore } from "./LocalMcpSettingsStore";
import { WidgetPackageSettingsStore } from "./WidgetPackageSettingsStore";
import type { CakeChatSessionStore } from "./CakeChatSessionStore";
import { UtilityModelSettingsStore } from "./UtilityModelSettingsStore";
import { EmbeddedEditorSettingsStore } from "./EmbeddedEditorSettingsStore";
import { HotkeySettingsStore } from "./HotkeySettingsStore";
import { GlobalLabelSettingsStore } from "./GlobalLabelSettingsStore";
import { CakeChatSettingsStore } from "./CakeChatSettingsStore";
import { CakeChatOverlaySettingsStore } from "./CakeChatOverlaySettingsStore";
import { CakePromptSettingsStore } from "./CakePromptSettingsStore";
import { GlobalInstructionsStore } from "./GlobalInstructionsStore";
import { NonChatModelSettingsStore } from "./NonChatModelSettingsStore";
import { ExperimentalSettingsStore } from "./ExperimentalSettingsStore";
import type { ExperimentalFeatures } from "../models/ExperimentalFeatures";
import { settingsSectionError, type SettingsError } from "../lib/settings-error";

import type { SettingsPageId } from "../../contracts/application/settings-navigation";

export interface SettingsStoreProps {
  visible(): boolean;
  browserHost: boolean;
  dictation: DictationStore;
  experimentalFeatures: ExperimentalFeatures;
  speech: SpeechSettingsStore;
  speechInput: SpeechInputSettingsStore;
  screenCapture: ScreenCaptureAttachmentStore;
  desktopConnection?: DesktopConnectionStore;
  operations: SessionOperationCoordinatorStore;
  activeSession(): ProjectSessionStore | CakeChatSessionStore | undefined;
}

/** Coordinates the focused workflows presented by the settings surface. */
export class SettingsStore extends Store<SettingsStoreProps> {
  constructor(props: SettingsStore["props"]) {
    super(props);
    this.effect(() => {
      const page = this.props.visible() ? this.activePage : undefined;
      // Page entry owns refresh; request state must not retrigger activation.
      untracked(() => {
        if (page === "mcp") {
          void this.localMcp.load();
          void this.mcp.load();
        } else if (page === "widget-packages") void this.widgetPackages.load();
        else if (page === "runtime") void this.providers.loadExtensions();
        else if (page === "voice" && !this.props.browserHost) void this.dictation.refreshDevices();
      });
    });
  }

  activePage: SettingsPageId = "models";
  /** Ephemeral navigation intent shared by Settings search and authorized agent controls. */
  scrollRequest: { targetId: string } | undefined;
  get desktopConnection() {
    return this.props.desktopConnection;
  }

  @child get mcp(): McpSettingsStore {
    return createStore(McpSettingsStore, {
      projectSession: () =>
        this.activeSession instanceof ProjectSessionStore ? this.activeSession : undefined,
    });
  }
  @child get localMcp(): LocalMcpSettingsStore {
    return createStore(LocalMcpSettingsStore);
  }
  @child get widgetPackages(): WidgetPackageSettingsStore {
    return createStore(WidgetPackageSettingsStore);
  }
  @child get desktopSharing(): DesktopSharingSettingsStore {
    return createStore(DesktopSharingSettingsStore);
  }
  @child get agentNavigation(): AgentNavigationSettingsStore {
    return createStore(AgentNavigationSettingsStore);
  }
  @child get appearance(): AppearanceSettingsStore {
    return createStore(AppearanceSettingsStore);
  }
  @child get experimental(): ExperimentalSettingsStore {
    return createStore(ExperimentalSettingsStore, { model: this.props.experimentalFeatures });
  }
  @child get nonChatModels(): NonChatModelSettingsStore {
    return createStore(NonChatModelSettingsStore);
  }
  @child get utilityModel(): UtilityModelSettingsStore {
    return createStore(UtilityModelSettingsStore);
  }
  @child get embeddedEditor(): EmbeddedEditorSettingsStore {
    return createStore(EmbeddedEditorSettingsStore);
  }
  @child get hotkeys(): HotkeySettingsStore {
    return createStore(HotkeySettingsStore);
  }
  @child get globalLabels(): GlobalLabelSettingsStore {
    return createStore(GlobalLabelSettingsStore);
  }
  @child get modelPresets(): ModelPresetSettingsStore {
    return createStore(ModelPresetSettingsStore);
  }
  @child get cakeChat(): CakeChatSettingsStore {
    return createStore(CakeChatSettingsStore);
  }
  @child get companion(): CakeChatSettingsStore {
    return createStore(CakeChatSettingsStore, { companion: true });
  }
  @child get cakeChatOverlay(): CakeChatOverlaySettingsStore {
    return createStore(CakeChatOverlaySettingsStore);
  }
  @child get cakePrompts(): CakePromptSettingsStore {
    return createStore(CakePromptSettingsStore);
  }
  @child get globalInstructions(): GlobalInstructionsStore {
    return createStore(GlobalInstructionsStore);
  }
  @child get providers(): ProviderSettingsStore {
    return createStore(ProviderSettingsStore, {
      operations: this.props.operations,
      providerPage: () =>
        this.activePage === "images" || this.activePage === "classifiers"
          ? this.activePage
          : "providers",
    });
  }

  get screenCapture() {
    return this.props.screenCapture;
  }

  get speech() {
    return this.props.speech;
  }

  get speechInput() {
    return this.props.speechInput;
  }

  get dictation() {
    return this.props.dictation;
  }

  get activeSession() {
    return this.props.activeSession();
  }
  get configuration() {
    return this.activeSession?.conversationSessionStore.configurationStore;
  }
  get piSettings() {
    return this.providers.piSettings;
  }
  get authNotice() {
    return this.activeSession?.model.uiParts.find(
      (part) => part.kind === "notice" && part.id === "auth-status",
    );
  }

  /** Keep each message attached to its own details and recovery destination. */
  get sectionErrors(): SettingsError[] {
    return [
      ...settingsSectionError("experimental", this.experimental),
      ...settingsSectionError("cake-chat", this.cakeChat),
      ...settingsSectionError("cake-chat", this.companion),
      ...(this.providers.error ? [this.providers.error] : []),
      ...settingsSectionError(this.nonChatModels.errorSection, this.nonChatModels),
      ...settingsSectionError("models", this.utilityModel),
      ...settingsSectionError("models", this.modelPresets),
      ...settingsSectionError(this.cakePrompts.errorSection, this.cakePrompts),
      ...settingsSectionError("prompts", this.globalInstructions),
      ...settingsSectionError("labels", this.globalLabels),
      ...settingsSectionError("models", this.configuration),
    ];
  }

  get globalError(): SettingsError | undefined {
    return this.providers.settingsLoadError;
  }

  errorForPage(page: SettingsPageId): SettingsError | undefined {
    return this.sectionErrors.find((error) => error.section === page);
  }

  selectPage(page: SettingsPageId) {
    this.activePage = page;
    this.scrollRequest = undefined;
  }

  requestTarget(page: SettingsPageId, targetId: string) {
    this.activePage = page;
    this.scrollRequest = { targetId };
  }

  settingsSection(section: CakeSettingsSectionId): CakeSettingsSectionView {
    if (section === "appearance")
      return {
        section,
        settings: {
          theme: this.appearance.theme,
          lightTheme: this.appearance.lightTheme,
          darkTheme: this.appearance.darkTheme,
          projectAvatarsEnabled: this.appearance.projectAvatarsEnabled,
          sessionAvatarsEnabled: this.appearance.sessionAvatarsEnabled,
          sidebarCharactersEnabled: this.appearance.sidebarCharactersEnabled,
          workLogViewMode: this.appearance.workLogViewMode,
          workLogsExpansion: this.appearance.workLogsExpansion,
        },
      };
    if (section === "editor")
      return {
        section,
        settings: {
          sidebarAutoHide: this.embeddedEditor.sidebarAutoHide,
          sidebarAutoHideWidth: this.embeddedEditor.sidebarAutoHideWidth,
        },
      };
    return {
      section,
      settings: {
        bindings: hotkeyDefinitions.map((definition) => ({
          action: definition.id,
          label: definition.label,
          description: definition.description,
          defaultBinding: definition.defaultBinding,
          binding: this.hotkeys.bindingFor(definition.id),
          customized: Object.hasOwn(this.hotkeys.bindings, definition.id),
        })),
      },
    };
  }

  updateSettings(input: CakeSettingsUpdate): CakeSettingsSectionView {
    if (input.section === "appearance") {
      const changes = input.changes;
      if (changes.theme !== undefined) this.appearance.setTheme(changes.theme);
      if (changes.lightTheme !== undefined)
        this.appearance.setPreferredTheme("light", changes.lightTheme);
      if (changes.darkTheme !== undefined)
        this.appearance.setPreferredTheme("dark", changes.darkTheme);
      if (changes.projectAvatarsEnabled !== undefined)
        this.appearance.setProjectAvatarsEnabled(changes.projectAvatarsEnabled);
      if (changes.sessionAvatarsEnabled !== undefined)
        this.appearance.setSessionAvatarsEnabled(changes.sessionAvatarsEnabled);
      if (changes.sidebarCharactersEnabled !== undefined)
        this.appearance.setSidebarCharactersEnabled(changes.sidebarCharactersEnabled);
      if (changes.workLogViewMode !== undefined)
        this.appearance.setWorkLogViewMode(changes.workLogViewMode);
      if (changes.workLogsExpansion !== undefined)
        this.appearance.setWorkLogsExpansion(changes.workLogsExpansion);
    } else if (input.section === "editor") {
      const changes = input.changes;
      if (changes.sidebarAutoHide !== undefined)
        this.embeddedEditor.setSidebarAutoHide(changes.sidebarAutoHide);
      if (changes.sidebarAutoHideWidth !== undefined)
        this.embeddedEditor.setSidebarAutoHideWidth(changes.sidebarAutoHideWidth);
    } else {
      for (const change of input.changes.bindings) {
        if (change.binding === null) this.hotkeys.reset(change.action);
        else if (change.binding === "") this.hotkeys.clear(change.action);
        else this.hotkeys.assign(change.action, change.binding);
      }
    }
    return this.settingsSection(input.section);
  }

  applyApplicationState(revision: number, state: ApplicationState) {
    this.utilityModel.applyApplicationState(revision, state);
    this.nonChatModels.applyApplicationState(revision, state);
    this.modelPresets.applyApplicationState(revision, state);
    this.cakePrompts.applyApplicationState(revision, state);
    this.cakeChat.applyApplicationState(revision, state);
    this.companion.applyApplicationState(revision, state);
    this.globalInstructions.applyApplicationState(revision, state);
    this.globalLabels.applyApplicationState(revision, state);
  }
}
