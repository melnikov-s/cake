import { Store, child, createStore } from "r-state-tree";
import type { ApplicationState } from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { EditorSettingsStore } from "./EditorSettingsStore";
import { ModelPresetSettingsStore } from "./ModelPresetSettingsStore";
import { ProviderSettingsStore } from "./ProviderSettingsStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { UtilityModelSettingsStore } from "./UtilityModelSettingsStore";

export interface SettingsStoreProps {
  client: Pick<
    DesktopClient,
    | "setPiSetting"
    | "reloadPi"
    | "refreshModels"
    | "login"
    | "logout"
    | "setEditorCommand"
    | "setUtilityModel"
    | "setModelPresets"
  >;
  sessionContext(): { sessionId: string } | undefined;
  operations: SessionOperationCoordinatorStore;
}

/** Coordinates the focused workflows presented by the settings surface. */
export class SettingsStore extends Store<SettingsStoreProps> {
  @child get appearance(): AppearanceSettingsStore {
    return createStore(AppearanceSettingsStore);
  }
  @child get utilityModel(): UtilityModelSettingsStore {
    return createStore(UtilityModelSettingsStore, { client: this.props.client });
  }
  @child get modelPresets(): ModelPresetSettingsStore {
    return createStore(ModelPresetSettingsStore, { client: this.props.client });
  }
  @child get editor(): EditorSettingsStore {
    return createStore(EditorSettingsStore, { client: this.props.client });
  }
  @child get providers(): ProviderSettingsStore {
    return createStore(ProviderSettingsStore, {
      client: this.props.client,
      sessionContext: this.props.sessionContext,
      operations: this.props.operations,
    });
  }

  get error() {
    return (
      this.providers.error ??
      this.utilityModel.error ??
      this.modelPresets.error ??
      this.editor.error
    );
  }
  get errorDetails() {
    return (
      this.providers.errorDetails ??
      this.utilityModel.errorDetails ??
      this.modelPresets.errorDetails ??
      this.editor.errorDetails
    );
  }

  applyApplicationState(state: ApplicationState) {
    this.utilityModel.applyApplicationState(state);
    this.modelPresets.applyApplicationState(state);
    this.editor.applyApplicationState(state);
  }
  receive(event: DesktopClientEvent) {
    this.providers.receive(event);
  }
}
