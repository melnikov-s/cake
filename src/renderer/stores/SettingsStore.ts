import { Store, child, createStore } from "r-state-tree";
import type { ApplicationState } from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import type { ModelPresetSettingsStoreInstance } from "./ModelPresetSettingsStore";
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
    | "setUtilityModel"
    | "listModels"
  >;
  sessionContext(): { sessionId: string } | undefined;
  operations: SessionOperationCoordinatorStore;
  modelPresets: ModelPresetSettingsStoreInstance;
}

/** Coordinates the focused workflows presented by the settings surface. */
export class SettingsStore extends Store<SettingsStoreProps> {
  // Temporary invalidation bridge for legacy r-state-tree consumers. The Effect Store remains
  // the sole Model Preset owner; remove this counter when the remaining consumers migrate.
  private modelPresetRevision = 0;

  constructor(props: SettingsStore["props"]) {
    super(props);
    this.effect(() =>
      this.props.modelPresets.revision.subscribe(() => {
        this.modelPresetRevision += 1;
      }),
    );
  }
  @child get appearance(): AppearanceSettingsStore {
    return createStore(AppearanceSettingsStore);
  }
  @child get utilityModel(): UtilityModelSettingsStore {
    return createStore(UtilityModelSettingsStore, { client: this.props.client });
  }
  get modelPresets(): ModelPresetSettingsStoreInstance {
    void this.modelPresetRevision;
    return this.props.modelPresets;
  }
  @child get providers(): ProviderSettingsStore {
    return createStore(ProviderSettingsStore, {
      client: this.props.client,
      sessionContext: this.props.sessionContext,
      operations: this.props.operations,
    });
  }

  get error() {
    return this.providers.error ?? this.utilityModel.error;
  }
  get errorDetails() {
    return this.providers.errorDetails ?? this.utilityModel.errorDetails;
  }

  applyApplicationState(state: ApplicationState) {
    this.utilityModel.applyApplicationState(state);
  }
  receive(event: DesktopClientEvent) {
    this.providers.receive(event);
  }
}
