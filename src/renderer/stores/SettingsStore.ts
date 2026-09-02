import { Store, child, createStore } from "r-state-tree";
import type { ApplicationState } from "../../ipc/session-contract";
import { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { ModelPresetSettingsStore } from "./ModelPresetSettingsStore";
import { ProviderSettingsStore } from "./ProviderSettingsStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { UtilityModelSettingsStore } from "./UtilityModelSettingsStore";

export interface SettingsStoreProps {
  operations: SessionOperationCoordinatorStore;
}

/** Coordinates the focused workflows presented by the settings surface. */
export class SettingsStore extends Store<SettingsStoreProps> {
  @child get appearance(): AppearanceSettingsStore {
    return createStore(AppearanceSettingsStore);
  }
  @child get utilityModel(): UtilityModelSettingsStore {
    return createStore(UtilityModelSettingsStore);
  }
  @child get modelPresets(): ModelPresetSettingsStore {
    return createStore(ModelPresetSettingsStore);
  }
  @child get providers(): ProviderSettingsStore {
    return createStore(ProviderSettingsStore, {
      operations: this.props.operations,
    });
  }

  get error() {
    return this.providers.error ?? this.utilityModel.error ?? this.modelPresets.error;
  }
  get errorDetails() {
    return (
      this.providers.errorDetails ??
      this.utilityModel.errorDetails ??
      this.modelPresets.errorDetails
    );
  }

  applyApplicationState(revision: number, state: ApplicationState) {
    this.utilityModel.applyApplicationState(revision, state);
  }
}
