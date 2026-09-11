import { Store, child, createStore } from "r-state-tree";
import type {
  CakeSettingsSectionId,
  CakeSettingsSectionView,
  CakeSettingsUpdate,
} from "../../domain/application/cake-settings-data";
import type { ApplicationState } from "../../ipc/session-contract";
import { hotkeyDefinitions } from "../lib/hotkeys";
import { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { ModelPresetSettingsStore } from "./ModelPresetSettingsStore";
import { ProviderSettingsStore } from "./ProviderSettingsStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { ProjectSessionStore } from "./ProjectSessionStore";
import type { CakeChatSessionStore } from "./CakeChatSessionStore";
import { UtilityModelSettingsStore } from "./UtilityModelSettingsStore";
import { EmbeddedEditorSettingsStore } from "./EmbeddedEditorSettingsStore";
import { HotkeySettingsStore } from "./HotkeySettingsStore";
import { GlobalStatusSettingsStore } from "./GlobalStatusSettingsStore";

export type SettingsPageId =
  | "models"
  | "providers"
  | "agent"
  | "runtime"
  | "network"
  | "statuses"
  | "appearance"
  | "hotkeys"
  | "editor";

export interface SettingsStoreProps {
  operations: SessionOperationCoordinatorStore;
  activeSession(): ProjectSessionStore | CakeChatSessionStore | undefined;
  workbenchError(): string | undefined;
}

/** Coordinates the focused workflows presented by the settings surface. */
export class SettingsStore extends Store<SettingsStoreProps> {
  activePage: SettingsPageId = "models";

  @child get appearance(): AppearanceSettingsStore {
    return createStore(AppearanceSettingsStore);
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
  @child get globalStatuses(): GlobalStatusSettingsStore {
    return createStore(GlobalStatusSettingsStore);
  }
  @child get modelPresets(): ModelPresetSettingsStore {
    return createStore(ModelPresetSettingsStore);
  }
  @child get providers(): ProviderSettingsStore {
    return createStore(ProviderSettingsStore, {
      operations: this.props.operations,
    });
  }

  get activeSession() {
    return this.props.activeSession();
  }
  get configuration() {
    return this.activeSession?.conversationSessionStore.configurationStore;
  }
  get piSettings() {
    return this.activeSession?.model.piSettings;
  }
  get providerGroups() {
    return this.configuration?.modelsByProvider ?? [];
  }
  get authNotice() {
    return this.activeSession?.model.uiParts.find(
      (part) => part.kind === "notice" && part.id === "auth-status",
    );
  }

  get error() {
    return (
      this.providers.error ??
      this.utilityModel.error ??
      this.modelPresets.error ??
      this.globalStatuses.error ??
      this.configuration?.error ??
      this.props.workbenchError()
    );
  }
  get errorDetails() {
    return (
      this.providers.errorDetails ??
      this.utilityModel.errorDetails ??
      this.modelPresets.errorDetails
    );
  }

  selectPage(page: SettingsPageId) {
    this.activePage = page;
  }

  settingsSection(section: CakeSettingsSectionId): CakeSettingsSectionView {
    if (section === "appearance")
      return {
        section,
        settings: {
          theme: this.appearance.theme,
          projectAvatarsEnabled: this.appearance.projectAvatarsEnabled,
          sessionAvatarsEnabled: this.appearance.sessionAvatarsEnabled,
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
      if (changes.projectAvatarsEnabled !== undefined)
        this.appearance.setProjectAvatarsEnabled(changes.projectAvatarsEnabled);
      if (changes.sessionAvatarsEnabled !== undefined)
        this.appearance.setSessionAvatarsEnabled(changes.sessionAvatarsEnabled);
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
    this.modelPresets.applyApplicationState(revision, state);
    this.globalStatuses.applyApplicationState(revision, state);
  }
}
