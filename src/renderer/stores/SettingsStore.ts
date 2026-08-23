import { Store, observable } from "r-state-tree";
import {
  DEFAULT_EDITOR_COMMAND,
  type ApplicationState,
  type ModelPreset,
  type PiSettingUpdate,
  type ThinkingLevel,
  type UtilityModel,
} from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { describeError } from "../error-details";

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

/** Owns model, reasoning, Pi preference, and provider-authentication workflows. */
export class SettingsStore extends Store<SettingsStoreProps> {
  theme: "system" | "light" | "dark" = "system";
  providerOperations: Record<string, { provider: string; kind: "login" | "logout" }> = observable(
    {},
  );
  utilityModel: UtilityModel | undefined;
  utilityModelSaving = false;
  readonly modelPresets: ModelPreset[] = observable([]);
  defaultModelPresetId: string | undefined;
  modelPresetsSaving = false;
  modelPresetsSectionRevision = 0;
  editorCommand = DEFAULT_EDITOR_COMMAND;
  error: string | undefined;
  errorDetails: string | undefined;
  private refreshOperationId: string | undefined;
  private utilitySaveRevision = 0;
  private utilitySaveQueue: Promise<unknown> = Promise.resolve();
  private persistedUtilityModel: UtilityModel | undefined;
  private modelPresetSaveRevision = 0;
  private modelPresetSaveQueue: Promise<unknown> = Promise.resolve();
  private persistedModelPresets: ModelPreset[] = [];
  private persistedDefaultModelPresetId: string | undefined;
  private editorSaveRevision = 0;
  private editorSaveQueue: Promise<unknown> = Promise.resolve();
  private persistedEditorCommand = DEFAULT_EDITOR_COMMAND;
  get activeOperations() {
    return this.props.operations.active("settings");
  }

  get refreshingModels() {
    return Boolean(
      this.refreshOperationId && this.activeOperations.includes(this.refreshOperationId),
    );
  }

  private reportError(error: unknown) {
    const described = describeError(error);
    this.error = described.message;
    this.errorDetails = described.details;
  }

  setTheme(theme: "system" | "light" | "dark") {
    this.theme = theme;
  }

  applyApplicationState(state: ApplicationState) {
    this.persistedUtilityModel = state.utilityModel;
    this.utilityModel = state.utilityModel;
    this.persistedEditorCommand = state.editorCommand?.trim() || DEFAULT_EDITOR_COMMAND;
    this.editorCommand = this.persistedEditorCommand;
    this.persistedModelPresets = (state.modelPresets ?? []).map((preset) => ({ ...preset }));
    this.persistedDefaultModelPresetId = state.defaultModelPresetId;
    if (!this.modelPresetsSaving) {
      this.modelPresets.splice(0, this.modelPresets.length, ...this.persistedModelPresets);
      this.defaultModelPresetId = this.persistedDefaultModelPresetId;
    }
  }

  get defaultModelPreset() {
    const preset = this.modelPresets.find(
      (candidate) => candidate.id === this.defaultModelPresetId,
    );
    return preset
      ? {
          provider: preset.provider,
          modelId: preset.modelId,
          thinkingLevel: preset.thinkingLevel,
          fastMode: preset.fastMode,
        }
      : undefined;
  }

  requestModelPresetsSection() {
    this.modelPresetsSectionRevision += 1;
  }

  createModelPreset(preset: Omit<ModelPreset, "id">) {
    return this.saveModelPresets([...this.modelPresets, { ...preset, id: crypto.randomUUID() }]);
  }

  updateModelPreset(preset: ModelPreset) {
    return this.saveModelPresets(
      this.modelPresets.map((current) => (current.id === preset.id ? preset : current)),
    );
  }

  duplicateModelPreset(id: string) {
    const source = this.modelPresets.find((preset) => preset.id === id);
    if (!source) return Promise.resolve();
    return this.createModelPreset({ ...source, name: `${source.name} copy` });
  }

  deleteModelPreset(id: string) {
    return this.saveModelPresets(
      this.modelPresets.filter((preset) => preset.id !== id),
      this.defaultModelPresetId === id ? undefined : this.defaultModelPresetId,
    );
  }

  setDefaultModelPreset(id: string | undefined) {
    return this.saveModelPresets(this.modelPresets, id);
  }

  setEditorCommand(command: string) {
    const revision = ++this.editorSaveRevision;
    const normalized = command.trim() || DEFAULT_EDITOR_COMMAND;
    this.editorCommand = normalized;
    this.error = undefined;
    this.errorDetails = undefined;
    const save = this.editorSaveQueue
      .catch(() => undefined)
      .then(() => this.props.client.setEditorCommand(normalized))
      .then((state) => {
        this.persistedEditorCommand = state.editorCommand?.trim() || DEFAULT_EDITOR_COMMAND;
        if (revision === this.editorSaveRevision) this.editorCommand = this.persistedEditorCommand;
      })
      .catch((error) => {
        if (revision === this.editorSaveRevision) {
          this.editorCommand = this.persistedEditorCommand;
          this.reportError(error);
        }
      });
    this.editorSaveQueue = save;
    return save;
  }

  selectUtilityModel(value: string, thinkingLevel?: ThinkingLevel) {
    const separator = value.indexOf("/");
    if (separator < 1) return Promise.resolve();
    return this.saveUtilityModel({
      provider: value.slice(0, separator),
      modelId: value.slice(separator + 1),
      thinkingLevel: thinkingLevel ?? this.utilityModel?.thinkingLevel ?? "off",
    });
  }

  selectUtilityThinkingLevel(thinkingLevel: ThinkingLevel) {
    if (!this.utilityModel) return Promise.resolve();
    return this.saveUtilityModel({ ...this.utilityModel, thinkingLevel });
  }

  clearUtilityModel() {
    return this.saveUtilityModel(undefined);
  }

  async setPiSetting(update: PiSettingUpdate) {
    await this.run((operationId, sessionId) =>
      this.props.client.setPiSetting({ operationId, sessionId, update }),
    );
  }

  async reloadPi() {
    await this.run((operationId, sessionId) =>
      this.props.client.reloadPi({ operationId, sessionId }),
    );
  }

  async refreshModels() {
    if (this.refreshingModels) return;
    this.error = undefined;
    this.errorDetails = undefined;
    const operationId = this.props.operations.start("settings");
    this.refreshOperationId = operationId;
    try {
      await this.props.client.refreshModels({
        operationId,
        sessionId: this.requireSessionId(),
      });
    } catch (error) {
      this.refreshOperationId = undefined;
      this.reportError(error);
      this.finish(operationId);
    }
  }

  async authenticate(provider: string, authType: "api_key" | "oauth") {
    if (this.providerOperation(provider)) return;
    this.error = undefined;
    this.errorDetails = undefined;
    const operationId = this.props.operations.start("settings");
    this.providerOperations[operationId] = { provider, kind: "login" };
    try {
      const sessionId = this.requireSessionId();
      await this.props.client.login({ operationId, sessionId, provider, authType });
    } catch (error) {
      delete this.providerOperations[operationId];
      this.reportError(error);
      this.finish(operationId);
    }
  }

  async logout(provider: string) {
    if (this.providerOperation(provider)) return;
    this.error = undefined;
    this.errorDetails = undefined;
    const operationId = this.props.operations.start("settings");
    this.providerOperations[operationId] = { provider, kind: "logout" };
    try {
      const sessionId = this.requireSessionId();
      await this.props.client.logout({ operationId, sessionId, provider });
    } catch (error) {
      delete this.providerOperations[operationId];
      this.reportError(error);
      this.finish(operationId);
    }
  }

  providerOperation(provider: string) {
    return Object.values(this.providerOperations).find(
      (operation) => operation.provider === provider,
    )?.kind;
  }

  receive(event: DesktopClientEvent) {
    if (event.type === "operation-completed" && this.activeOperations.includes(event.operationId)) {
      if (this.providerOperations[event.operationId])
        delete this.providerOperations[event.operationId];
      if (this.refreshOperationId === event.operationId) this.refreshOperationId = undefined;
      this.finish(event.operationId);
    }
    if (
      event.type === "operation-failed" &&
      event.operationId &&
      this.activeOperations.includes(event.operationId)
    ) {
      if (this.providerOperations[event.operationId])
        delete this.providerOperations[event.operationId];
      if (this.refreshOperationId === event.operationId) this.refreshOperationId = undefined;
      this.finish(event.operationId);
      this.reportError(event.message);
    }
    if (
      event.type === "pi-state-changed" &&
      (event.state === "failed" || event.state === "stopped")
    ) {
      this.refreshOperationId = undefined;
      for (const operationId of this.activeOperations.slice()) {
        if (this.providerOperations[operationId]) delete this.providerOperations[operationId];
        this.finish(operationId);
      }
    }
  }

  private saveModelPresets(
    presets: readonly ModelPreset[],
    defaultPresetId = this.defaultModelPresetId,
  ) {
    const revision = ++this.modelPresetSaveRevision;
    const optimistic = presets.map((preset) => ({ ...preset }));
    this.modelPresets.splice(0, this.modelPresets.length, ...optimistic);
    this.defaultModelPresetId = defaultPresetId;
    this.modelPresetsSaving = true;
    this.error = undefined;
    this.errorDetails = undefined;
    const save = this.modelPresetSaveQueue
      .catch(() => undefined)
      .then(() => this.props.client.setModelPresets(optimistic, defaultPresetId))
      .then((state) => {
        this.persistedModelPresets = (state.modelPresets ?? []).map((preset) => ({ ...preset }));
        this.persistedDefaultModelPresetId = state.defaultModelPresetId;
        if (revision === this.modelPresetSaveRevision) {
          this.modelPresets.splice(0, this.modelPresets.length, ...this.persistedModelPresets);
          this.defaultModelPresetId = this.persistedDefaultModelPresetId;
        }
      })
      .catch((error) => {
        if (revision === this.modelPresetSaveRevision) {
          this.modelPresets.splice(
            0,
            this.modelPresets.length,
            ...this.persistedModelPresets.map((preset) => ({ ...preset })),
          );
          this.defaultModelPresetId = this.persistedDefaultModelPresetId;
          this.reportError(error);
        }
      })
      .finally(() => {
        if (revision === this.modelPresetSaveRevision) this.modelPresetsSaving = false;
      });
    this.modelPresetSaveQueue = save;
    return save;
  }

  private saveUtilityModel(model: UtilityModel | undefined) {
    const revision = ++this.utilitySaveRevision;
    this.utilityModel = model;
    this.utilityModelSaving = true;
    this.error = undefined;
    this.errorDetails = undefined;
    const save = this.utilitySaveQueue
      .catch(() => undefined)
      .then(() => this.props.client.setUtilityModel(model))
      .then((state) => {
        this.persistedUtilityModel = state.utilityModel;
        if (revision === this.utilitySaveRevision) this.utilityModel = state.utilityModel;
      })
      .catch((error) => {
        if (revision === this.utilitySaveRevision) {
          this.utilityModel = this.persistedUtilityModel;
          this.reportError(error);
        }
      })
      .finally(() => {
        if (revision === this.utilitySaveRevision) this.utilityModelSaving = false;
      });
    this.utilitySaveQueue = save;
    return save;
  }

  private requireSessionId() {
    const context = this.props.sessionContext();
    if (!context) throw new Error("No active session");
    return context.sessionId;
  }

  private async run(command: (operationId: string, sessionId: string) => Promise<void>) {
    this.error = undefined;
    this.errorDetails = undefined;
    const operationId = this.props.operations.start("settings");
    try {
      await command(operationId, this.requireSessionId());
    } catch (error) {
      this.reportError(error);
      this.finish(operationId);
    }
  }

  private finish(operationId: string) {
    this.props.operations.finish(operationId);
  }
}
