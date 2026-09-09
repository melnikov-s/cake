import { Store, child, createStore } from "r-state-tree";
import type { ApplicationState } from "../../ipc/session-contract";
import { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { ModelPresetSettingsStore } from "./ModelPresetSettingsStore";
import { ProviderSettingsStore } from "./ProviderSettingsStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { ProjectSessionStore } from "./ProjectSessionStore";
import type { CakeChatSessionStore } from "./CakeChatSessionStore";
import { UtilityModelSettingsStore } from "./UtilityModelSettingsStore";
import { EmbeddedEditorSettingsStore } from "./EmbeddedEditorSettingsStore";
import { HotkeySettingsStore } from "./HotkeySettingsStore";

export type SettingsPageId =
  | "models"
  | "providers"
  | "agent"
  | "runtime"
  | "network"
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

  applyApplicationState(revision: number, state: ApplicationState) {
    this.utilityModel.applyApplicationState(revision, state);
    this.modelPresets.applyApplicationState(revision, state);
  }
}
